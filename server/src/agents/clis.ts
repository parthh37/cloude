import type { AgentCli } from '../../../shared/protocol.js';
import { which } from '../config.js';
import { db, now } from '../db.js';
import { ensureSchema } from '../schema.js';
import { buildEnv } from '../settings.js';
import { run, toolVersion } from '../util/exec.js';
import { HttpError, slugify } from '../util/paths.js';

/**
 * Coding-agent CLIs besides the built-in Claude sessions. Each one can be opened
 * interactively in a terminal, or run headless on a board card inside its own
 * worktree. Presets are a starting point: a custom entry with the same id
 * overrides the preset (CLIs change their flags often), and any other CLI can
 * be added from Settings.
 */

ensureSchema(
  'agent-clis-v1',
  `
  CREATE TABLE agent_clis (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL,
    headless TEXT,
    install TEXT,
    bin TEXT NOT NULL,
    env_keys TEXT NOT NULL DEFAULT '[]',
    docs_url TEXT,
    created_at INTEGER NOT NULL
  );
  `,
);

type CliDef = Omit<AgentCli, 'installed' | 'version' | 'builtin'>;

const PRESETS: CliDef[] = [
  {
    id: 'claude',
    name: 'Claude Code CLI',
    description: 'The interactive Claude Code TUI. Board cards with this agent run `claude -p`; Cloude sessions use the same engine with richer UI.',
    command: 'claude',
    headless: 'claude -p {prompt} --permission-mode acceptEdits',
    install: 'npm install -g @anthropic-ai/claude-code',
    bin: 'claude',
    envKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    description: 'OpenAI’s coding agent. Sign in with `codex login` in a terminal or set OPENAI_API_KEY.',
    command: 'codex',
    headless: 'codex exec --full-auto {prompt}',
    install: 'npm install -g @openai/codex',
    bin: 'codex',
    envKeys: ['OPENAI_API_KEY'],
    docsUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google’s open-source agent. Uses GEMINI_API_KEY (or a Google login in the terminal).',
    command: 'gemini',
    headless: 'gemini --yolo -p {prompt}',
    install: 'npm install -g @google/gemini-cli',
    bin: 'gemini',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: 'Agent tuned for Qwen3-Coder; works with any OpenAI-compatible endpoint (OPENAI_BASE_URL).',
    command: 'qwen',
    headless: 'qwen --yolo -p {prompt}',
    install: 'npm install -g @qwen-code/qwen-code',
    bin: 'qwen',
    envKeys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DASHSCOPE_API_KEY'],
    docsUrl: 'https://github.com/QwenLM/qwen-code',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Provider-agnostic terminal agent (Anthropic, OpenAI, Gemini, local models).',
    command: 'opencode',
    headless: 'opencode run {prompt}',
    install: 'npm install -g opencode-ai',
    bin: 'opencode',
    envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
    docsUrl: 'https://opencode.ai/docs',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    description: 'GitHub’s agent in the terminal. Authenticates with GH_TOKEN (needs a Copilot plan).',
    command: 'copilot',
    headless: 'copilot --allow-all-tools -p {prompt}',
    install: 'npm install -g @github/copilot',
    bin: 'copilot',
    envKeys: ['GH_TOKEN'],
    docsUrl: 'https://github.com/github/copilot-cli',
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'Pair-programming agent with git-aware edits. Works with Claude, GPT, Gemini, DeepSeek and local models.',
    command: 'aider',
    headless: 'aider --yes-always --message {prompt}',
    install: 'uv tool install --python 3.12 aider-chat',
    bin: 'aider',
    envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY'],
    docsUrl: 'https://aider.chat/docs/',
  },
  {
    id: 'aider-ollama',
    name: 'Aider + local Llama (Ollama)',
    description: 'Aider driving a local model through Ollama — no API key, nothing leaves the server. Start `ollama serve` as a service first.',
    command: 'aider --model ollama_chat/llama3.1',
    headless: 'aider --model ollama_chat/llama3.1 --yes-always --message {prompt}',
    install: 'uv tool install --python 3.12 aider-chat',
    bin: 'aider',
    envKeys: ['OLLAMA_API_BASE'],
    docsUrl: 'https://aider.chat/docs/llms/ollama.html',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Runs open models locally (Llama, Qwen, DeepSeek, Mistral…). Chat in a terminal, or serve them to Aider/OpenCode.',
    command: 'ollama run llama3.1',
    headless: 'ollama run llama3.1 {prompt}',
    install: 'curl -fsSL https://ollama.com/install.sh | sh',
    bin: 'ollama',
    envKeys: [],
    docsUrl: 'https://ollama.com/library',
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    description: 'Cursor’s agent as a CLI. Uses CURSOR_API_KEY.',
    command: 'cursor-agent',
    headless: 'cursor-agent --force -p {prompt}',
    install: 'curl -fsS https://cursor.com/install | bash',
    bin: 'cursor-agent',
    envKeys: ['CURSOR_API_KEY'],
    docsUrl: 'https://cursor.com/cli',
  },
  {
    id: 'goose',
    name: 'Goose',
    description: 'Block’s extensible open-source agent (MCP-native).',
    command: 'goose session',
    headless: 'goose run -t {prompt}',
    install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash',
    bin: 'goose',
    envKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    docsUrl: 'https://block.github.io/goose/',
  },
];

interface CliRow {
  id: string;
  name: string;
  description: string;
  command: string;
  headless: string | null;
  install: string | null;
  bin: string;
  env_keys: string;
  docs_url: string | null;
}

const rowToDef = (r: CliRow): CliDef => ({
  id: r.id,
  name: r.name,
  description: r.description,
  command: r.command,
  headless: r.headless,
  install: r.install,
  bin: r.bin,
  envKeys: JSON.parse(r.env_keys || '[]'),
  docsUrl: r.docs_url,
});

let versionCache: { at: number; values: Map<string, string | null> } | null = null;

/** POSIX single-quote a string for `bash -lc`. */
export function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defs(): { def: CliDef; builtin: boolean }[] {
  const custom = (db.prepare('SELECT * FROM agent_clis ORDER BY created_at').all() as unknown as CliRow[]).map(rowToDef);
  const byId = new Map(custom.map((c) => [c.id, c]));
  const out = PRESETS.map((p) => ({ def: byId.get(p.id) ?? p, builtin: true }));
  for (const c of custom) if (!PRESETS.some((p) => p.id === c.id)) out.push({ def: c, builtin: false });
  return out;
}

async function versions(bins: string[], fresh = false) {
  if (!fresh && versionCache && Date.now() - versionCache.at < 5 * 60_000 && bins.every((b) => versionCache!.values.has(b))) return versionCache.values;
  const values = new Map<string, string | null>();
  await Promise.all(
    [...new Set(bins)].map(async (bin) => {
      values.set(bin, which(bin) ? ((await toolVersion(bin)) ?? 'installed') : null);
    }),
  );
  versionCache = { at: Date.now(), values };
  return values;
}

export const agentClis = {
  async list(fresh = false): Promise<AgentCli[]> {
    const all = defs();
    const v = await versions(
      all.map((d) => d.def.bin),
      fresh,
    );
    return all.map(({ def, builtin }) => {
      const version = v.get(def.bin) ?? null;
      return { ...def, builtin, installed: version !== null, version: version === 'installed' ? null : version };
    });
  },

  get(id: string): (CliDef & { builtin: boolean }) | null {
    const hit = defs().find((d) => d.def.id === id);
    return hit ? { ...hit.def, builtin: hit.builtin } : null;
  },

  require(id: string) {
    const c = this.get(id);
    if (!c) throw new HttpError(404, `Unknown agent CLI "${id}"`);
    return c;
  },

  /** Create or override (same id as a preset) a CLI definition. */
  save(input: Partial<CliDef> & { name: string; command: string }): AgentCli['id'] {
    if (!input.name?.trim() || !input.command?.trim()) throw new HttpError(400, 'Name and command are required');
    const id = slugify(input.id?.trim() || input.name);
    const bin = input.bin?.trim() || input.command.trim().split(/\s+/)[0]!;
    if (input.headless && !input.headless.includes('{prompt}')) throw new HttpError(400, 'The headless command must contain {prompt}');
    db.prepare(
      `INSERT INTO agent_clis (id, name, description, command, headless, install, bin, env_keys, docs_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, command = excluded.command,
         headless = excluded.headless, install = excluded.install, bin = excluded.bin, env_keys = excluded.env_keys, docs_url = excluded.docs_url`,
    ).run(
      id,
      input.name.trim(),
      input.description?.trim() ?? '',
      input.command.trim(),
      input.headless?.trim() || null,
      input.install?.trim() || null,
      bin,
      JSON.stringify((input.envKeys ?? []).map((k) => k.trim()).filter(Boolean)),
      input.docsUrl?.trim() || null,
      now(),
    );
    versionCache = null;
    return id;
  },

  /** Delete a custom CLI, or reset an overridden preset back to its defaults. */
  remove(id: string) {
    db.prepare('DELETE FROM agent_clis WHERE id = ?').run(id);
    versionCache = null;
  },

  async install(id: string): Promise<{ ok: boolean; output: string }> {
    const c = this.require(id);
    if (!c.install) throw new HttpError(400, `${c.name} has no install command`);
    const r = await run('bash', ['-lc', c.install], { env: buildEnv(null), timeoutMs: 15 * 60_000 });
    versionCache = null;
    const output = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-40).join('\n');
    return { ok: r.code === 0, output };
  },

  /** The shell command that runs `prompt` non-interactively with this CLI. */
  headlessCommand(id: string, prompt: string): string {
    const c = this.require(id);
    if (!c.headless) throw new HttpError(400, `${c.name} has no headless mode configured; open it in a terminal instead`);
    return c.headless.split('{prompt}').join(shellQuote(prompt));
  },
};
