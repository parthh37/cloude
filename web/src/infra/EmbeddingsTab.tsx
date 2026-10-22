import { BrainCircuit, CheckCircle2, CircleAlert, Lock, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EmbeddingConfig, EmbeddingProviderKind, EmbeddingStatus, SemanticHit } from '../../../shared/protocol';
import { Badge, Button, Field, Input, Select, Spinner, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { toast, useStore } from '../lib/store';
import { Card, Hint, err, usePoll } from './shared';

const PROVIDER_LABEL: Record<EmbeddingProviderKind, string> = {
  local: 'Local (in Cloude)',
  ollama: 'Ollama',
  voyage: 'Voyage AI',
  gemini: 'Google Gemini',
  jina: 'Jina AI',
  mistral: 'Mistral',
  openai: 'OpenAI-compatible',
};

const LOCAL_MODELS = ['Xenova/bge-small-en-v1.5', 'Xenova/all-MiniLM-L6-v2', 'nomic-ai/nomic-embed-text-v1.5', 'jinaai/jina-embeddings-v2-base-code'];

function TryIt() {
  const projects = useStore((s) => s.projects);
  const [a, setA] = useState('How do users sign in?');
  const [b, setB] = useState('export async function verifyPassword(user, password) { … }');
  const [sim, setSim] = useState<number | null>(null);
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SemanticHit[] | null>(null);
  const [busy, setBusy] = useState<'compare' | 'search' | 'reindex' | null>(null);
  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  return (
    <Card title="Try it" description="Compare two texts, or search a project by meaning — the same semantic_search tool Claude uses.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Textarea rows={2} value={a} onChange={(e) => setA(e.target.value)} aria-label="First text" />
        <Textarea rows={2} value={b} onChange={(e) => setB(e.target.value)} aria-label="Second text" />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Button
          size="sm"
          busy={busy === 'compare'}
          onClick={async () => {
            setBusy('compare');
            try {
              setSim((await api.post<{ similarity: number }>('/api/infra/embeddings/compare', { a, b })).similarity);
            } catch (e) {
              toast('error', 'Compare failed', err(e));
            } finally {
              setBusy(null);
            }
          }}
        >
          Compare
        </Button>
        {sim !== null && (
          <span className="text-sm">
            similarity <strong className="font-semibold">{sim.toFixed(3)}</strong>
          </span>
        )}
      </div>

      <form
        className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!projectId || !query.trim()) return;
          setBusy('search');
          try {
            setHits((await api.post<{ hits: SemanticHit[] }>('/api/infra/embeddings/search', { projectId, query })).hits);
          } catch (e2) {
            toast('error', 'Search failed', err(e2));
          } finally {
            setBusy(null);
          }
        }}
      >
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-44" aria-label="Project">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="where are refunds calculated?" className="min-w-48 flex-1" />
        <Button type="submit" icon={<Search className="size-4" />} busy={busy === 'search'} disabled={!projectId}>
          Search
        </Button>
        <Button
          type="button"
          variant="ghost"
          busy={busy === 'reindex'}
          disabled={!projectId}
          onClick={async () => {
            setBusy('reindex');
            try {
              const r = await api.post<{ files: number; embedded: number }>('/api/infra/embeddings/reindex', { projectId });
              toast('success', 'Re-indexed', `${r.files} files · ${r.embedded} chunks embedded`);
            } catch (e) {
              toast('error', 'Re-index failed', err(e));
            } finally {
              setBusy(null);
            }
          }}
        >
          Re-index
        </Button>
      </form>
      {busy === 'search' && <Hint>The first search in a project indexes it; that can take a minute on large repos.</Hint>}
      {hits && (
        <ul className="mt-3 space-y-2">
          {hits.length === 0 && <Hint>No results.</Hint>}
          {hits.map((h) => (
            <li key={`${h.path}:${h.startLine}`} className="rounded-xl border border-line">
              <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                  {h.path}:{h.startLine}-{h.endLine}
                </span>
                <Badge tone="sky">{h.score.toFixed(3)}</Badge>
              </div>
              <pre className="porthole max-h-40 overflow-auto rounded-t-none px-3 py-2 text-xs whitespace-pre-wrap">{h.preview}</pre>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function EmbeddingsTab() {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [draft, setDraft] = useState<EmbeddingConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = status?.state === 'detecting' || status?.state === 'installing';
  const { data } = usePoll(() => api.get<EmbeddingStatus>('/api/infra/embeddings'), pending ? 2000 : 15_000, [pending]);
  useEffect(() => {
    if (!data) return;
    setStatus(data);
    setDraft((d) => d ?? data.config);
  }, [data]);

  if (!status || !draft) return <Card title="Embeddings">Loading…</Card>;
  const a = status.active;

  const save = async (patch: Partial<EmbeddingConfig>) => {
    setBusy(true);
    try {
      const s = await api.put<EmbeddingStatus>('/api/infra/embeddings', { ...draft, ...patch });
      setStatus(s);
      setDraft(s.config);
      toast(s.state === 'ready' ? 'success' : 'warning', s.state === 'ready' ? 'Embeddings ready' : 'Embeddings not ready', s.message ?? undefined);
    } catch (e) {
      toast('error', 'Could not configure embeddings', err(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card
        title={
          <span className="flex items-center gap-2">
            <BrainCircuit className="size-5 text-dawn" /> Embeddings
          </span>
        }
        description="Vector embeddings power semantic code search for Claude. In automatic mode Cloude picks a free model — preferring ones that run on this server so your code never leaves it."
        actions={
          <Button
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            busy={busy || pending}
            onClick={async () => {
              setBusy(true);
              try {
                setStatus(await api.post<EmbeddingStatus>('/api/infra/embeddings/detect'));
              } catch (e) {
                toast('error', 'Detection failed', err(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Re-detect
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {status.state === 'ready' ? (
            <CheckCircle2 className="size-4 text-ok" />
          ) : pending ? (
            <Spinner className="size-4 text-sky" />
          ) : (
            <CircleAlert className="size-4 text-bad" />
          )}
          {a ? (
            <>
              <strong className="font-semibold">{PROVIDER_LABEL[a.provider]}</strong>
              <span className="font-mono text-[13px]">{a.model}</span>
              {a.dimensions && <Badge>{a.dimensions} dims</Badge>}
              {a.free && <Badge tone="ok">free</Badge>}
              {a.private && (
                <Badge tone="ok">
                  <Lock className="size-3" /> private
                </Badge>
              )}
              {!a.private && <Badge tone="break">sends text to {PROVIDER_LABEL[a.provider]}</Badge>}
            </>
          ) : (
            <span className="text-ink-2">{status.state === 'unconfigured' ? 'Not configured yet' : status.state}</span>
          )}
        </div>
        {status.message && <p className="mt-1.5 text-sm text-ink-2">{status.message}</p>}
        <p className="mt-1 text-xs text-ink-3">
          Index: {status.index.files} files · {status.index.chunks} chunks in {status.index.projects} project(s)
          {status.detectedAt && ` · detected ${timeAgo(status.detectedAt)}`}
        </p>
      </Card>

      <Card title="Model" description="Automatic is recommended. Manual lets you pin a provider — e.g. a hosted model you already pay for.">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Mode">
            <Select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as EmbeddingConfig['mode'] })}>
              <option value="auto">Automatic (free first)</option>
              <option value="manual">Manual</option>
            </Select>
          </Field>
          {draft.mode === 'manual' && (
            <>
              <Field label="Provider">
                <Select value={draft.provider ?? ''} onChange={(e) => setDraft({ ...draft, provider: (e.target.value || null) as EmbeddingProviderKind | null, model: null })}>
                  <option value="">Choose…</option>
                  {(Object.keys(PROVIDER_LABEL) as EmbeddingProviderKind[]).map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Model">
                <Input
                  list="cloude-embedding-models"
                  value={draft.model ?? ''}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}
                  placeholder={status.candidates.find((c) => c.provider === draft.provider)?.model ?? 'default'}
                  className="font-mono text-[13px]"
                />
                <datalist id="cloude-embedding-models">{draft.provider === 'local' && LOCAL_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
              </Field>
              {(draft.provider === 'ollama' || draft.provider === 'openai') && (
                <Field label="Base URL">
                  <Input value={draft.baseUrl ?? ''} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value || null })} placeholder={draft.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com'} />
                </Field>
              )}
            </>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="primary" busy={busy} onClick={() => save({})}>
            Apply
          </Button>
        </div>
      </Card>

      <Card title="Detected options" description="Add an API key in Settings → Secrets to make a hosted provider available.">
        <ul className="divide-y divide-line">
          {status.candidates.map((c) => (
            <li key={c.provider} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className={c.available ? 'size-2 rounded-full bg-ok' : 'size-2 rounded-full bg-line-strong'} />
              <span className="w-36 font-medium">{PROVIDER_LABEL[c.provider]}</span>
              <span className="font-mono text-xs text-ink-2">{c.model}</span>
              {c.free && <Badge tone="ok">free</Badge>}
              {c.private && <Badge tone="ok">private</Badge>}
              <span className="w-full text-xs text-ink-3 sm:ml-auto sm:w-auto">{c.detail}</span>
            </li>
          ))}
        </ul>
      </Card>

      <TryIt />
    </div>
  );
}
