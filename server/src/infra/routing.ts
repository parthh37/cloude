import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, ModelProvider, ProviderCheck, RoutingConfig, RoutingDecision, TaskKind, TaskKindInfo } from '../../../shared/protocol.js';
import { db, now } from '../db.js';
import { secrets, settings } from '../settings.js';
import { HttpError } from '../util/paths.js';
import { kv } from './store.js';

/**
 * Model & provider routing — the "master page" logic.
 *
 * Each Claude Code process talks to exactly one provider, chosen by environment
 * variables (CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_BASE_URL, …), and runs one main
 * model plus role models (subagents, background work). Routing picks those when
 * a session's process starts, based on what the session is for.
 */

export const TASK_KINDS: TaskKindInfo[] = [
  { id: 'general', label: 'General', hint: 'Anything not matched below — also the fallback route' },
  { id: 'plan', label: 'Planning & architecture', hint: 'Designs, specs, big refactors, migrations' },
  { id: 'code', label: 'Feature coding', hint: 'Building features end to end' },
  { id: 'debug', label: 'Debugging & fixes', hint: 'Errors, failing tests, crashes, performance' },
  { id: 'review', label: 'Review & security', hint: 'Code review, audits, hardening' },
  { id: 'test', label: 'Testing & QA', hint: 'Writing tests, browser and sandbox testing' },
  { id: 'ui', label: 'Frontend & UI', hint: 'Components, styling, layout' },
  { id: 'infra', label: 'DevOps & infrastructure', hint: 'Docker, CI, deploys, sandboxes, servers' },
  { id: 'docs', label: 'Docs & writing', hint: 'READMEs, comments, changelogs' },
  { id: 'quick', label: 'Quick questions', hint: 'Small edits, lookups, one-liners' },
  { id: 'research', label: 'Research & exploration', hint: 'Reading code, comparing options' },
];
const TASK_IDS = new Set(TASK_KINDS.map((t) => t.id));

export const ANTHROPIC_PROVIDER: ModelProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: null,
  authSecret: null,
  authStyle: 'x-api-key',
  region: null,
  cloudProject: null,
  resource: null,
  extraEnv: {},
  models: ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5'],
  builtin: true,
};

const route = (model: string, effort: EffortLevel | null = null) => ({ providerId: 'anthropic', model, effort, fallbackModel: null });

/** Off until you turn it on; the table comes pre-filled so enabling is one click. */
export const DEFAULT_ROUTING: RoutingConfig = {
  enabled: false,
  autoClassify: true,
  routes: {
    general: route('claude-opus-5-5'),
    plan: route('claude-fable-5-1', 'high'),
    code: route('claude-opus-5-5'),
    debug: route('claude-opus-5-5', 'high'),
    review: route('claude-opus-5-5', 'high'),
    test: route('claude-sonnet-5-5'),
    ui: route('claude-sonnet-5-5'),
    infra: route('claude-sonnet-5-5'),
    docs: route('claude-sonnet-5-5'),
    quick: route('claude-haiku-5-5', 'low'),
    research: route('claude-sonnet-5-5'),
  },
  roles: { subagent: null, background: null },
  providers: [],
};

export function routingConfig(): RoutingConfig {
  const c = kv.get<RoutingConfig>('routing', DEFAULT_ROUTING);
  return { ...c, providers: [ANTHROPIC_PROVIDER, ...c.providers.filter((p) => p.id !== 'anthropic')] };
}

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function setRoutingConfig(patch: Partial<RoutingConfig>): RoutingConfig {
  const cur = routingConfig();
  const next: RoutingConfig = { ...cur, ...patch, routes: { ...cur.routes, ...(patch.routes ?? {}) }, roles: { ...cur.roles, ...(patch.roles ?? {}) } };
  const providers = (next.providers ?? []).filter((p) => p.id !== 'anthropic');
  const ids = new Set<string>();
  for (const p of providers) {
    if (!PROVIDER_ID_RE.test(p.id)) throw new HttpError(400, `Provider id "${p.id}" must be lowercase letters, digits and "-"`);
    if (ids.has(p.id)) throw new HttpError(400, `Duplicate provider id "${p.id}"`);
    ids.add(p.id);
    if ((p.kind === 'gateway' || p.kind === 'ollama') && p.baseUrl && !/^https?:\/\//.test(p.baseUrl)) throw new HttpError(400, `${p.name}: base URL must start with http(s)://`);
    p.models = [...new Set((p.models ?? []).map((m) => m.trim()).filter(Boolean))];
    p.extraEnv = p.extraEnv ?? {};
    p.builtin = false;
  }
  for (const [task, r] of Object.entries(next.routes)) {
    if (!TASK_IDS.has(task as TaskKind)) delete next.routes[task as TaskKind];
    else if (r && !r.model.trim()) throw new HttpError(400, `Route "${task}" needs a model`);
  }
  kv.set('routing', { ...next, providers });
  return routingConfig();
}

// ---- deciding the task -------------------------------------------------------------------

/**
 * Guess what kind of work a session is, from its first message.
 *
 * Called only when the message has no explicit `#task` tag and nobody set the
 * task by hand. Return null when unsure — the session then uses the "general" route.
 * Examples it should handle: "why does login 500 on Safari?" (debug), "add dark
 * mode to settings" (ui or code), "what does this repo do?" (research / quick).
 */
export function classifyTask(text: string): TaskKind | null {
  // TODO(you): your task taxonomy, your call (5-10 lines). See the notes in the chat.
  void text;
  return null;
}

function firstMessage(sessionId: string): string {
  const row = db.prepare(`SELECT data FROM session_events WHERE session_id = ? AND kind = 'user' ORDER BY seq LIMIT 1`).get(sessionId) as { data: string } | undefined;
  try {
    return row ? String((JSON.parse(row.data) as { text?: string }).text ?? '') : '';
  } catch {
    return '';
  }
}

export function setSessionTask(sessionId: string, task: TaskKind | null) {
  if (task === null) {
    db.prepare('DELETE FROM infra_session_tasks WHERE session_id = ?').run(sessionId);
    return;
  }
  if (!TASK_IDS.has(task)) throw new HttpError(400, `Unknown task "${task}"`);
  db.prepare(
    `INSERT INTO infra_session_tasks (session_id, task, source, updated_at) VALUES (?, ?, 'manual', ?)
     ON CONFLICT(session_id) DO UPDATE SET task = excluded.task, source = excluded.source, updated_at = excluded.updated_at`,
  ).run(sessionId, task, now());
}

export function decideTask(sessionId: string, cfg: RoutingConfig): { task: TaskKind; source: RoutingDecision['source'] } {
  const manual = db.prepare('SELECT task FROM infra_session_tasks WHERE session_id = ?').get(sessionId) as { task: TaskKind } | undefined;
  if (manual && TASK_IDS.has(manual.task)) return { task: manual.task, source: 'manual' };
  const text = firstMessage(sessionId);
  const tag = /(?:^|\s)#([a-z]+)\b/i.exec(text)?.[1]?.toLowerCase() as TaskKind | undefined;
  if (tag && TASK_IDS.has(tag)) return { task: tag, source: 'tag' };
  if (cfg.autoClassify && text) {
    try {
      const guess = classifyTask(text);
      if (guess && TASK_IDS.has(guess)) return { task: guess, source: 'classifier' };
    } catch (e) {
      console.error('[routing] classifyTask threw:', e);
    }
  }
  return { task: 'general', source: 'default' };
}

// ---- provider environments ---------------------------------------------------------------------

const PROVIDER_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
const ANTHROPIC_CREDENTIALS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function secretValue(name: string | null, projectId: string): string | undefined {
  if (!name) return undefined;
  return secrets.values(projectId)[name] ?? secrets.values(null)[name] ?? process.env[name];
}

/**
 * The complete environment for a Claude process on `p`. The SDK's `env` REPLACES the
 * child environment, so this starts from the full base env and edits it.
 * Anthropic credentials are removed for every non-Anthropic provider: a subscription
 * token or API key must never be sent to a third-party gateway.
 */
export function providerEnv(p: ModelProvider, base: Record<string, string>, projectId: string): Record<string, string> {
  const env = { ...base };
  if (p.kind === 'anthropic') return { ...env, ...p.extraEnv };
  for (const k of [...PROVIDER_SWITCHES, ...ANTHROPIC_CREDENTIALS]) delete env[k];
  const secret = secretValue(p.authSecret, projectId);
  switch (p.kind) {
    case 'bedrock':
      env.CLAUDE_CODE_USE_BEDROCK = '1';
      if (p.region) env.AWS_REGION = p.region;
      if (secret) env.AWS_BEARER_TOKEN_BEDROCK = secret;
      if (p.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = p.baseUrl;
      break;
    case 'vertex':
      env.CLAUDE_CODE_USE_VERTEX = '1';
      env.CLOUD_ML_REGION = p.region || 'global';
      if (p.cloudProject) env.ANTHROPIC_VERTEX_PROJECT_ID = p.cloudProject;
      if (p.baseUrl) env.ANTHROPIC_VERTEX_BASE_URL = p.baseUrl;
      break;
    case 'foundry':
      env.CLAUDE_CODE_USE_FOUNDRY = '1';
      if (p.resource) env.ANTHROPIC_FOUNDRY_RESOURCE = p.resource;
      if (p.baseUrl) env.ANTHROPIC_FOUNDRY_BASE_URL = p.baseUrl;
      if (secret) env.ANTHROPIC_FOUNDRY_API_KEY = secret;
      break;
    case 'gateway':
    case 'ollama': {
      env.ANTHROPIC_BASE_URL = (p.baseUrl || (p.kind === 'ollama' ? 'http://localhost:11434' : '')).replace(/\/+$/, '');
      const token = secret ?? (p.kind === 'ollama' ? 'ollama' : '');
      if (p.authStyle === 'bearer' || p.kind === 'ollama') {
        env.ANTHROPIC_AUTH_TOKEN = token;
        env.ANTHROPIC_API_KEY = ''; // some gateways reject requests carrying both
      } else {
        env.ANTHROPIC_API_KEY = token;
      }
      break;
    }
  }
  return { ...env, ...p.extraEnv };
}

// ---- applying a route to a session ----------------------------------------------------------------

function record(d: Omit<RoutingDecision, 'sessionTitle' | 'at'>) {
  db.prepare('INSERT INTO infra_routing_decisions (session_id, task, source, provider_id, model, applied, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    d.sessionId,
    d.task,
    d.source,
    d.providerId,
    d.model,
    d.applied ? 1 : 0,
    d.reason,
    now(),
  );
  db.prepare('DELETE FROM infra_routing_decisions WHERE id <= (SELECT MAX(id) FROM infra_routing_decisions) - 200').run();
}

function lastRoutedModel(sessionId: string): string | null {
  const r = db.prepare('SELECT model FROM infra_routing_decisions WHERE session_id = ? AND applied = 1 ORDER BY id DESC LIMIT 1').get(sessionId) as { model: string } | undefined;
  return r?.model ?? null;
}

export interface RoutableRow {
  id: string;
  model: string | null;
  effort: EffortLevel | null;
}

/**
 * Called once per Claude process start. Mutates the SDK options (model, effort,
 * fallback, env) and the session row's model, so the UI shows what actually runs.
 * Sessions whose model was picked by hand are never re-routed.
 */
export function applyRouting(options: Options, row: RoutableRow, projectId: string) {
  const cfg = routingConfig();
  if (!cfg.enabled) return;
  const defaultModel = settings.get().defaultModel;
  const routed = lastRoutedModel(row.id);
  if (row.model && row.model !== defaultModel && row.model !== routed) {
    record({ sessionId: row.id, task: 'general', source: 'manual', providerId: '-', model: row.model, applied: false, reason: 'Model picked by hand — kept' });
    return;
  }
  const { task, source } = decideTask(row.id, cfg);
  const r = cfg.routes[task] ?? cfg.routes.general;
  if (!r) return;
  const provider = cfg.providers.find((p) => p.id === r.providerId);
  if (!provider) {
    record({ sessionId: row.id, task, source, providerId: r.providerId, model: r.model, applied: false, reason: `Provider "${r.providerId}" no longer exists` });
    return;
  }

  const env = providerEnv(provider, (options.env ?? {}) as Record<string, string>, projectId);
  const sameProvider = (role: { providerId: string } | null) => role && role.providerId === provider.id;
  if (sameProvider(cfg.roles.subagent)) env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.roles.subagent!.model;
  if (sameProvider(cfg.roles.background)) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.roles.background!.model;
    env.ANTHROPIC_SMALL_FAST_MODEL = cfg.roles.background!.model;
  }
  options.env = env;
  options.model = r.model;
  if (r.effort && !row.effort) options.effort = r.effort;
  if (r.fallbackModel) options.fallbackModel = r.fallbackModel;
  // Non-Claude models behind a gateway may not understand Claude's thinking parameters.
  if ((provider.kind === 'gateway' || provider.kind === 'ollama') && !/^claude-/.test(r.model)) delete options.thinking;

  if (row.model !== r.model) {
    row.model = r.model;
    db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(r.model, row.id);
  }
  record({ sessionId: row.id, task, source, providerId: provider.id, model: r.model, applied: true, reason: `${task} → ${provider.name} · ${r.model}` });
}

export function decisions(limit = 30): RoutingDecision[] {
  const rows = db
    .prepare(
      `SELECT d.*, s.title AS title FROM infra_routing_decisions d LEFT JOIN sessions s ON s.id = d.session_id ORDER BY d.id DESC LIMIT ?`,
    )
    .all(limit) as { session_id: string; title: string | null; task: TaskKind; source: RoutingDecision['source']; provider_id: string; model: string; applied: number; reason: string; at: number }[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    sessionTitle: r.title,
    task: r.task,
    source: r.source,
    providerId: r.provider_id,
    model: r.model,
    applied: !!r.applied,
    reason: r.reason,
    at: r.at,
  }));
}

// ---- checking providers ------------------------------------------------------------------------------

export async function checkProvider(p: ModelProvider): Promise<ProviderCheck> {
  const signal = AbortSignal.timeout(8000);
  try {
    if (p.kind === 'anthropic') {
      const env = { ...process.env, ...secrets.values(null) };
      const ok = !!(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
      return { ok, message: ok ? 'Claude account configured in Settings' : 'Uses the Claude account from Settings (or the server CLI login)', models: ANTHROPIC_PROVIDER.models };
    }
    if (p.kind === 'ollama') {
      const base = (p.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
      const r = await fetch(`${base}/api/tags`, { signal });
      if (!r.ok) return { ok: false, message: `Ollama answered ${r.status}`, models: [] };
      const models = ((await r.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
      return { ok: true, message: `Ollama reachable · ${models.length} model(s) installed`, models };
    }
    if (p.kind === 'gateway') {
      if (!p.baseUrl) return { ok: false, message: 'Set a base URL', models: [] };
      const token = secretValue(p.authSecret, '') ?? '';
      const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
      if (token) {
        if (p.authStyle === 'bearer') headers.authorization = `Bearer ${token}`;
        else headers['x-api-key'] = token;
      }
      const r = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/v1/models`, { headers, signal });
      if (!r.ok) return { ok: false, message: `Gateway answered ${r.status} ${r.statusText}`, models: [] };
      const body = (await r.json()) as { data?: { id: string }[] };
      const models = body.data?.map((m) => m.id) ?? [];
      return { ok: true, message: `Gateway reachable · ${models.length} model(s) listed`, models };
    }
    const missing =
      p.kind === 'bedrock' ? (!p.region ? 'region' : null) : p.kind === 'vertex' ? (!p.cloudProject ? 'GCP project id' : null) : !p.resource && !p.baseUrl ? 'resource name' : null;
    return missing
      ? { ok: false, message: `Missing ${missing}`, models: [] }
      : { ok: true, message: 'Configured — credentials are verified when the first session starts', models: p.models };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), models: [] };
  }
}
