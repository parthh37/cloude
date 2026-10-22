import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EmbeddingCandidate, EmbeddingConfig, EmbeddingProviderKind, EmbeddingStatus } from '../../../shared/protocol.js';
import { config, which } from '../config.js';
import { db } from '../db.js';
import { secrets } from '../settings.js';
import { HttpError } from '../util/paths.js';
import { kv } from './store.js';

/**
 * Embeddings, auto-configured with a free model.
 *
 * Preference order in auto mode — free AND private first:
 *   1. Ollama is running and already has an embedding model
 *   2. the local ONNX runtime is already installed
 *   3. Ollama is running → pull nomic-embed-text
 *   4. install the local runtime (transformers.js) + a small model into the data dir
 *   5. a hosted free tier you have a key for (text leaves the server — never preferred)
 * The local runtime is installed on demand into $CLOUDE_DATA_DIR/embeddings instead of
 * package.json: it is ~300 MB of native binaries most installs never need.
 */

const DIR = path.join(config.dataDir, 'embeddings');
const RUNTIME_DIR = path.join(DIR, 'runtime');
const MODELS_DIR = path.join(DIR, 'models');
const RUNTIME_PKG = '@huggingface/transformers@4';

interface LocalModel {
  pooling: 'mean' | 'cls';
  dims: number;
  query?: string; // instruction prefix for queries
  doc?: string;
}
export const LOCAL_MODELS: Record<string, LocalModel> = {
  'Xenova/bge-small-en-v1.5': { pooling: 'cls', dims: 384, query: 'Represent this sentence for searching relevant passages: ' },
  'Xenova/all-MiniLM-L6-v2': { pooling: 'mean', dims: 384 },
  'nomic-ai/nomic-embed-text-v1.5': { pooling: 'mean', dims: 768, query: 'search_query: ', doc: 'search_document: ' },
  'jinaai/jina-embeddings-v2-base-code': { pooling: 'mean', dims: 768 },
};
const DEFAULT_LOCAL = 'Xenova/bge-small-en-v1.5';
const OLLAMA_PULL = 'nomic-embed-text';
const OLLAMA_EMBED_RE = /embed|bge|minilm|e5-|gte|arctic|mxbai|nomic|granite-embedding|qwen3-embedding/i;

interface Hosted {
  secretKeys: string[];
  model: string;
  free: boolean;
  detail: string;
}
const HOSTED: Record<Exclude<EmbeddingProviderKind, 'local' | 'ollama'>, Hosted> = {
  voyage: { secretKeys: ['VOYAGE_API_KEY'], model: 'voyage-code-3', free: true, detail: 'Voyage AI — 200M free tokens, tuned for code' },
  gemini: { secretKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], model: 'gemini-embedding-001', free: true, detail: 'Google Gemini — free tier (free-tier data may be used by Google)' },
  jina: { secretKeys: ['JINA_API_KEY'], model: 'jina-embeddings-v3', free: true, detail: 'Jina AI — free trial tokens' },
  mistral: { secretKeys: ['MISTRAL_API_KEY'], model: 'codestral-embed', free: true, detail: 'Mistral — free Experiment tier' },
  openai: { secretKeys: ['OPENAI_API_KEY'], model: 'text-embedding-3-small', free: false, detail: 'OpenAI or any OpenAI-compatible server (paid unless self-hosted)' },
};

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = { mode: 'auto', provider: null, model: null, baseUrl: null, secret: null };

export function embeddingConfig(): EmbeddingConfig {
  return kv.get('embeddings.config', DEFAULT_EMBEDDING_CONFIG);
}

type Kind = 'query' | 'document';

interface Backend {
  provider: EmbeddingProviderKind;
  model: string;
  dims: number | null;
  free: boolean;
  private: boolean;
  embed(texts: string[], kind: Kind): Promise<number[][]>;
}

function secretFor(names: string[], explicit?: string | null): string | undefined {
  const all = { ...process.env, ...secrets.values(null) } as Record<string, string | undefined>;
  if (explicit) return all[explicit];
  for (const n of names) if (all[n]) return all[n];
  return undefined;
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.|\[::1\])/.test(u);

// ---- backends ------------------------------------------------------------------------

function ollamaBase(cfg?: EmbeddingConfig) {
  return (cfg?.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'http://');
}

function ollamaBackend(base: string, model: string): Backend {
  const nomic = /nomic/i.test(model);
  return {
    provider: 'ollama',
    model,
    dims: null,
    free: true,
    private: isLocalUrl(base),
    async embed(texts, kind) {
      const input = nomic ? texts.map((t) => `${kind === 'query' ? 'search_query' : 'search_document'}: ${t}`) : texts;
      const r = await postJson<{ embeddings: number[][] }>(`${base}/api/embed`, { model, input, truncate: true }, {});
      return r.embeddings;
    },
  };
}

let localPipe: Promise<(texts: string[], o: object) => Promise<{ tolist(): number[][] }>> | null = null;
let localPipeModel: string | null = null;

const RUNTIME_PKG_DIR = path.join(RUNTIME_DIR, 'node_modules', '@huggingface', 'transformers');

function runtimeInstalled() {
  return fs.existsSync(path.join(RUNTIME_PKG_DIR, 'package.json'));
}

/** The package's Node ESM entry, read from its own exports map (require.resolve would give the CJS build). */
function runtimeEntry(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(RUNTIME_PKG_DIR, 'package.json'), 'utf8')) as { exports?: { node?: { import?: { default?: string } } }; module?: string };
  const rel = pkg.exports?.node?.import?.default ?? pkg.module ?? './dist/transformers.node.mjs';
  return path.join(RUNTIME_PKG_DIR, rel);
}

function localBackend(model: string): Backend {
  const spec = LOCAL_MODELS[model] ?? { pooling: 'mean' as const, dims: 0 };
  return {
    provider: 'local',
    model,
    dims: spec.dims || null,
    free: true,
    private: true,
    async embed(texts, kind) {
      if (!localPipe || localPipeModel !== model) {
        localPipeModel = model;
        localPipe = (async () => {
          const mod = (await import(pathToFileURL(runtimeEntry()).href)) as {
            pipeline: (task: string, model: string, o: object) => Promise<(texts: string[], o: object) => Promise<{ tolist(): number[][] }>>;
            env: { cacheDir: string; allowRemoteModels: boolean };
          };
          mod.env.cacheDir = MODELS_DIR;
          return mod.pipeline('feature-extraction', model, { dtype: 'q8' });
        })();
        localPipe.catch(() => (localPipe = null));
      }
      const pipe = await localPipe;
      const prefix = kind === 'query' ? (spec.query ?? '') : (spec.doc ?? '');
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16).map((t) => prefix + t);
        out.push(...(await pipe(batch, { pooling: spec.pooling, normalize: true })).tolist());
      }
      return out;
    },
  };
}

function hostedBackend(provider: Exclude<EmbeddingProviderKind, 'local' | 'ollama'>, cfg: EmbeddingConfig): Backend {
  const h = HOSTED[provider];
  const model = cfg.model || h.model;
  const key = secretFor(h.secretKeys, cfg.secret);
  if (!key && !(provider === 'openai' && cfg.baseUrl)) throw new Error(`No API key: add a ${h.secretKeys[0]} secret in Settings`);
  const bearer = { authorization: `Bearer ${key ?? ''}` };
  const embed: Backend['embed'] = async (texts, kind) => {
    switch (provider) {
      case 'voyage':
        return (await postJson<{ data: { embedding: number[] }[] }>('https://api.voyageai.com/v1/embeddings', { input: texts, model, input_type: kind }, bearer)).data.map((d) => d.embedding);
      case 'gemini':
        return (
          await postJson<{ embeddings: { values: number[] }[] }>(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
            {
              requests: texts.map((text) => ({
                model: `models/${model}`,
                content: { parts: [{ text }] },
                taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
                outputDimensionality: 768,
              })),
            },
            { 'x-goog-api-key': key! },
          )
        ).embeddings.map((e) => e.values);
      case 'jina':
        return (
          await postJson<{ data: { embedding: number[] }[] }>('https://api.jina.ai/v1/embeddings', { model, input: texts, task: kind === 'query' ? 'retrieval.query' : 'retrieval.passage' }, bearer)
        ).data.map((d) => d.embedding);
      case 'mistral':
        return (await postJson<{ data: { embedding: number[] }[] }>('https://api.mistral.ai/v1/embeddings', { model, input: texts }, bearer)).data.map((d) => d.embedding);
      case 'openai': {
        const base = (cfg.baseUrl || 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/, '');
        return (await postJson<{ data: { embedding: number[] }[] }>(`${base}/v1/embeddings`, { model, input: texts }, bearer)).data.map((d) => d.embedding);
      }
    }
  };
  // Batch to stay under every provider's per-request input limit.
  return {
    provider,
    model,
    dims: null,
    free: h.free || (provider === 'openai' && !!cfg.baseUrl && isLocalUrl(cfg.baseUrl)),
    private: provider === 'openai' && !!cfg.baseUrl && isLocalUrl(cfg.baseUrl),
    async embed(texts, kind) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64) out.push(...(await embed(texts.slice(i, i + 64), kind)));
      return out;
    },
  };
}

// ---- autoconfig ------------------------------------------------------------------------

async function ollamaModels(base: string): Promise<string[] | null> {
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    return ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch {
    return null;
  }
}

function installRuntime(): Promise<void> {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const pkg = path.join(RUNTIME_DIR, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'cloude-embeddings-runtime', private: true }));
  return new Promise((resolve, reject) => {
    const npm = spawn(which('npm') ?? 'npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--no-save', RUNTIME_PKG], { cwd: RUNTIME_DIR, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    npm.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    const timer = setTimeout(() => npm.kill('SIGKILL'), 15 * 60_000);
    npm.on('error', reject);
    npm.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && runtimeInstalled()) resolve();
      else reject(new Error(`npm install ${RUNTIME_PKG} failed: ${err.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

class Embeddings {
  private backend: Backend | null = null;
  private state: EmbeddingStatus['state'] = 'unconfigured';
  private message: string | null = null;
  private candidates: EmbeddingCandidate[] = [];
  private detectedAt: number | null = null;
  private detecting: Promise<void> | null = null;

  /** Bumps whenever the active model changes, so cached vectors from another model are never mixed. */
  get modelKey(): string | null {
    return this.backend ? `${this.backend.provider}:${this.backend.model}` : null;
  }

  status(): EmbeddingStatus {
    const idx = db.prepare('SELECT COUNT(DISTINCT project_id) AS p, COUNT(DISTINCT project_id || path) AS f, COUNT(*) AS c FROM infra_chunks WHERE model = ?').get(this.modelKey ?? '') as {
      p: number;
      f: number;
      c: number;
    };
    return {
      config: embeddingConfig(),
      active: this.backend ? { provider: this.backend.provider, model: this.backend.model, dimensions: this.backend.dims, free: this.backend.free, private: this.backend.private } : null,
      state: this.state,
      message: this.message,
      candidates: this.candidates,
      detectedAt: this.detectedAt,
      index: { projects: idx.p, files: idx.f, chunks: idx.c },
    };
  }

  setConfig(patch: Partial<EmbeddingConfig>): Promise<EmbeddingStatus> {
    const next = { ...embeddingConfig(), ...patch };
    if (next.mode === 'manual' && !next.provider) throw new HttpError(400, 'Pick a provider for manual mode');
    kv.set('embeddings.config', next);
    return this.configure().then(() => this.status());
  }

  /** (Re)build the active backend from the config: autodetect in auto mode. */
  configure(): Promise<void> {
    if (this.detecting) return this.detecting;
    this.detecting = this.run().finally(() => (this.detecting = null));
    return this.detecting;
  }

  private async run() {
    const cfg = embeddingConfig();
    this.state = 'detecting';
    this.message = null;
    try {
      this.candidates = await this.probe(cfg);
      this.detectedAt = Date.now();
      if (cfg.mode === 'manual' && cfg.provider) {
        await this.useManual(cfg);
      } else {
        await this.useAuto(cfg);
      }
      if (this.backend) {
        // Prove it works end to end (also downloads local model weights on first use).
        const [v] = await this.backend.embed(['hello world'], 'document');
        this.backend.dims = v?.length ?? this.backend.dims;
        this.state = 'ready';
        this.message = `${this.backend.free ? 'Free' : 'Paid'}${this.backend.private ? ', private' : ''} — ${this.backend.model} (${this.backend.dims} dims)`;
      }
    } catch (e) {
      this.backend = null;
      this.state = 'error';
      this.message = e instanceof Error ? e.message : String(e);
    }
  }

  private async probe(cfg: EmbeddingConfig): Promise<EmbeddingCandidate[]> {
    const out: EmbeddingCandidate[] = [];
    const base = ollamaBase(cfg);
    const models = await ollamaModels(base);
    const embedModel = models?.find((m) => OLLAMA_EMBED_RE.test(m));
    out.push({
      provider: 'ollama',
      model: embedModel ?? OLLAMA_PULL,
      available: !!models,
      free: true,
      private: isLocalUrl(base),
      detail: !models ? `Ollama not reachable at ${base}` : embedModel ? `Installed in Ollama at ${base}` : `Ollama running — will pull ${OLLAMA_PULL} (~270 MB)`,
    });
    out.push({
      provider: 'local',
      model: DEFAULT_LOCAL,
      available: true,
      free: true,
      private: true,
      detail: runtimeInstalled() ? 'Local ONNX runtime installed — runs inside Cloude' : 'Runs inside Cloude; installs the ONNX runtime (~300 MB) + a 34 MB model on first use',
    });
    for (const [provider, h] of Object.entries(HOSTED) as [keyof typeof HOSTED, Hosted][]) {
      const has = !!secretFor(h.secretKeys);
      out.push({ provider, model: h.model, available: has, free: h.free, private: false, detail: has ? h.detail : `${h.detail} — add a ${h.secretKeys[0]} secret` });
    }
    return out;
  }

  private async useAuto(cfg: EmbeddingConfig) {
    const base = ollamaBase(cfg);
    const models = await ollamaModels(base);
    const installed = models?.find((m) => OLLAMA_EMBED_RE.test(m));
    if (installed) {
      this.backend = ollamaBackend(base, installed);
      return;
    }
    if (runtimeInstalled()) {
      this.backend = localBackend(DEFAULT_LOCAL);
      return;
    }
    if (models) {
      try {
        this.state = 'installing';
        this.message = `Pulling ${OLLAMA_PULL} into Ollama…`;
        await postJson(`${base}/api/pull`, { model: OLLAMA_PULL, stream: false }, {});
        this.backend = ollamaBackend(base, OLLAMA_PULL);
        return;
      } catch {
        /* fall through to the local runtime */
      }
    }
    try {
      this.state = 'installing';
      this.message = 'Installing the local embedding runtime (one time, a few minutes)…';
      await installRuntime();
      this.backend = localBackend(DEFAULT_LOCAL);
      return;
    } catch (e) {
      // Last resort: a hosted free tier the user already has a key for.
      const hosted = this.candidates.find((c) => c.available && c.free && !c.private && c.provider !== 'ollama' && c.provider !== 'local');
      if (hosted) {
        this.backend = hostedBackend(hosted.provider as keyof typeof HOSTED, cfg);
        return;
      }
      throw e;
    }
  }

  private async useManual(cfg: EmbeddingConfig) {
    const p = cfg.provider!;
    if (p === 'ollama') {
      this.backend = ollamaBackend(ollamaBase(cfg), cfg.model || OLLAMA_PULL);
    } else if (p === 'local') {
      if (!runtimeInstalled()) {
        this.state = 'installing';
        this.message = 'Installing the local embedding runtime (one time, a few minutes)…';
        await installRuntime();
      }
      this.backend = localBackend(cfg.model || DEFAULT_LOCAL);
    } else {
      this.backend = hostedBackend(p, cfg);
    }
  }

  async embed(texts: string[], kind: Kind): Promise<number[][]> {
    if (!this.backend) {
      await this.configure();
      if (!this.backend) throw new HttpError(503, `Embeddings are not available: ${this.message ?? 'not configured'}`);
    }
    return this.backend.embed(texts, kind);
  }

  get ready() {
    return this.state === 'ready';
  }
}

export const embeddings = new Embeddings();

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
