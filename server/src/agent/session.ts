import crypto from 'node:crypto';
import {
  deleteSession as deleteClaudeTranscript,
  query,
  type CanUseTool,
  type ModelInfo,
  type OnElicitation,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  EffortLevel,
  ImageAttachment,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  Session,
  SessionEvent,
  SessionEventKind,
  SessionStatus,
} from '../../../shared/protocol.js';
import { config, playwrightMcp } from '../config.js';
import { db, now } from '../db.js';
import { hub } from '../hub.js';
import { applyInfra } from '../infra/session-hook.js';
import { projects } from '../projects.js';
import { buildEnv, settings } from '../settings.js';
import { assertWithinBudget, ingestRateLimitEvent, ingestUsageResponse, recordTurn } from '../usage.js';
import { AsyncQueue } from '../util/async-queue.js';
import { HttpError } from '../util/paths.js';
import { ActivityTracker } from './activity.js';
import { CLOUDE_READONLY_TOOLS, createCloudeMcp } from './cloude-mcp.js';
import { CompactionWatcher, applyCompaction } from './compaction.js';
import { guardHooks } from './guard.js';
import { cloudeSystemPrompt } from './system-prompt.js';

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  model: string | null;
  permission_mode: PermissionMode;
  effort: EffortLevel | null;
  status: SessionStatus;
  started: number;
  archived: number;
  total_cost_usd: number;
  last_seq: number;
  last_error: string | null;
  allowed_tools: string;
  usage_snapshot: string;
  created_at: number;
  updated_at: number;
}

export interface SessionInfo {
  model?: string;
  cwd?: string;
  version?: string;
  tools?: string[];
  slashCommands?: string[];
  commands?: SlashCommand[];
  models?: ModelInfo[];
  mcpServers?: { name: string; status: string }[];
  skills?: string[];
  agents?: string[];
  suggestion?: string | null;
}

/** SDK messages worth keeping in the replayable timeline. Everything else is live-only. */
const PERSISTED_SYSTEM_SUBTYPES = new Set([
  'init',
  'compact_boundary',
  'local_command_output',
  'task_started',
  'task_notification',
  'notification',
  'permission_denied',
  'informational',
  'conversation_reset',
  'model_refusal_fallback',
  'model_refusal_no_fallback',
  'api_retry',
]);

const MAX_STRING = 60_000;

const AUTH_HELP =
  'Claude is not authenticated on this server. Open Settings → Claude account and add an Anthropic API key or a ' +
  'Claude subscription token (run `claude setup-token` in a Cloude terminal), then send your message again.';

/** Bound giant tool outputs (e.g. Read of a 5 MB file) before they hit SQLite and every browser. */
function truncateDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}\n… [${value.length - MAX_STRING} more characters truncated by Cloude]` : value;
  }
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, depth + 1);
  return out;
}

function ruleToString(r: { toolName: string; ruleContent?: string }) {
  return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
}

function supportsAdaptiveThinking(model: string) {
  return !/haiku-4|sonnet-4-5|opus-4-[015]|claude-3/.test(model);
}

let lastPlanUsageAt = 0;

/** Activity is broadcast to every browser, so a busy session sends at most one update per this interval. */
const ACTIVITY_MIN_INTERVAL_MS = 1000;

interface Pending {
  req: PermissionRequest;
  resolve: (r: PermissionResponse) => void;
}

export class AgentSession {
  private q: Query | null = null;
  private input: AsyncQueue<SDKUserMessage> | null = null;
  private abort: AbortController | null = null;
  private pending = new Map<string, Pending>();
  private activity = new ActivityTracker(
    () => this.info.cwd,
    () => this.activityChanged(),
  );
  private activityTimer: NodeJS.Timeout | null = null;
  private activitySentAt = 0;
  private compaction = new CompactionWatcher({
    id: () => this.id,
    query: () => this.q,
    fail: (message) => this.record('error', { message }),
    changed: () => this.activityChanged(),
    settled: () => this.compactionSettled(),
  });
  private disposed = false;
  private ownUuids = new Set<string>();
  private idleTimer: NodeJS.Timeout | null = null;
  private authProblem = false;
  private resumedRun = false;
  private stderrTail: string[] = [];
  info: SessionInfo = {};

  constructor(public row: SessionRow) {}

  get id() {
    return this.row.id;
  }
  get alive() {
    return this.q !== null;
  }

  toJSON(): Session {
    const r = this.row;
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      model: r.model,
      permissionMode: r.permission_mode,
      effort: r.effort,
      status: r.status,
      started: !!r.started,
      alive: this.alive,
      activity: this.activity.current,
      context: this.compaction.context,
      archived: !!r.archived,
      totalCostUsd: r.total_cost_usd,
      lastSeq: r.last_seq,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ---- persistence ---------------------------------------------------------

  save(patch: Partial<SessionRow>, broadcast = true) {
    Object.assign(this.row, patch, { updated_at: now() });
    const keys = Object.keys(patch).concat('updated_at');
    db.prepare(`UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => (this.row as any)[k]),
      this.id,
    );
    if (broadcast) hub.broadcast({ t: 'session', session: this.toJSON() });
  }

  private setStatus(status: SessionStatus) {
    if (this.row.status !== status) this.save({ status });
  }

  record(kind: SessionEventKind, data: unknown): SessionEvent {
    const seq = this.row.last_seq + 1;
    const t = now();
    const stored = kind === 'sdk' ? truncateDeep(data) : data;
    db.prepare('INSERT INTO session_events (session_id, seq, kind, data, created_at) VALUES (?, ?, ?, ?, ?)').run(
      this.id,
      seq,
      kind,
      JSON.stringify(stored),
      t,
    );
    this.row.last_seq = seq;
    db.prepare('UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?').run(seq, t, this.id);
    const event: SessionEvent = { seq, sessionId: this.id, kind, data: stored, createdAt: t };
    hub.toSession(this.id, { t: 'event', event });
    return event;
  }

  events(after: number, limit = 5000): SessionEvent[] {
    const rows = db
      .prepare('SELECT seq, kind, data, created_at FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(this.id, after, limit) as { seq: number; kind: SessionEventKind; data: string; created_at: number }[];
    return rows.map((r) => ({ seq: r.seq, sessionId: this.id, kind: r.kind, data: JSON.parse(r.data), createdAt: r.created_at }));
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  private broadcastPending() {
    hub.broadcast({ t: 'pending', sessionId: this.id, requests: this.pendingRequests() });
  }

  // ---- user actions ----------------------------------------------------------

  send(text: string, images: ImageAttachment[] = []): void {
    if (!text.trim() && images.length === 0) throw new HttpError(400, 'Message is empty');
    assertWithinBudget();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const uuid = crypto.randomUUID();
    this.record('user', { text, uuid, images: images.map((i) => ({ mediaType: i.mediaType, name: i.name, data: i.data })) });
    if (this.row.title === 'New session' && text.trim() && !text.trim().startsWith('/')) {
      this.save({ title: text.trim().replace(/\s+/g, ' ').slice(0, 80) }, false);
    }
    projects.touch(this.row.project_id);
    this.ensureProcess();
    const content = images.length
      ? [
          ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.data } })),
          ...(text.trim() ? [{ type: 'text' as const, text }] : []),
        ]
      : text;
    this.ownUuids.add(uuid);
    this.input!.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid, session_id: this.id });
    this.info.suggestion = null;
    if (this.row.status !== 'starting') this.setStatus('running');
    else hub.broadcast({ t: 'session', session: this.toJSON() });
  }

  async interrupt() {
    if (!this.q) return;
    for (const id of [...this.pending.keys()]) this.settle(id, { decision: 'deny', message: 'Interrupted by user' }, true);
    await this.q.interrupt().catch(() => {});
  }

  /** Kill the Claude process. The conversation is kept and resumes on the next message. */
  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.input?.close();
    this.abort?.abort();
    this.q?.close();
  }

  async setModel(model: string | null) {
    this.save({ model });
    if (this.q) await this.q.setModel(model ?? undefined).catch((e) => this.record('error', { message: `setModel failed: ${e}` }));
  }

  async setPermissionMode(mode: PermissionMode) {
    this.save({ permission_mode: mode });
    if (this.q) await this.q.setPermissionMode(mode).catch((e) => this.record('error', { message: `setPermissionMode failed: ${e}` }));
  }

  async setEffort(effort: EffortLevel | null) {
    this.save({ effort });
    if (this.q) await this.q.applyFlagSettings({ effortLevel: effort }).catch(() => {});
  }

  async rewindFiles(userMessageUuid: string, dryRun = false) {
    this.ensureProcess();
    return this.q!.rewindFiles(userMessageUuid, { dryRun });
  }

  async refreshCommands() {
    if (!this.q) return;
    const [commands, models] = await Promise.all([this.q.supportedCommands().catch(() => undefined), this.q.supportedModels().catch(() => undefined)]);
    if (commands) this.info.commands = commands;
    if (models) this.info.models = models;
  }

  resolvePermission(requestId: string, response: PermissionResponse): boolean {
    return this.settle(requestId, response);
  }

  // ---- the Claude process ------------------------------------------------------

  private ensureProcess() {
    if (this.q) return;
    const project = projects.require(this.row.project_id);
    const s = settings.get();
    const model = this.row.model ?? s.defaultModel;
    const input = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    const allowed: string[] = JSON.parse(this.row.allowed_tools || '[]');

    const options: Options = {
      ...(config.claudePath ? { pathToClaudeCodeExecutable: config.claudePath } : {}),
      cwd: project.path,
      model,
      permissionMode: this.row.permission_mode,
      allowDangerouslySkipPermissions: true, // lets the user switch to bypass mode from the UI mid-session
      ...(this.row.effort ? { effort: this.row.effort } : s.defaultEffort ? { effort: s.defaultEffort } : {}),
      ...(supportsAdaptiveThinking(model) ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
      // Our session id IS Claude's session id: first run creates it, later runs resume it.
      ...(this.row.started ? { resume: this.id } : { sessionId: this.id }),
      abortController: abort,
      includePartialMessages: true,
      promptSuggestions: true,
      enableFileCheckpointing: true,
      settingSources: ['user', 'project', 'local'], // CLAUDE.md, .claude/settings*.json, skills, agents, commands
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: cloudeSystemPrompt(project, s.enablePlaywright, s.appendSystemPrompt),
      },
      env: buildEnv(project.id, { CLAUDE_AGENT_SDK_CLIENT_APP: `cloude/${config.version}` }),
      mcpServers: {
        cloude: createCloudeMcp(project, this.id),
        ...(s.enablePlaywright
          ? { playwright: { type: 'stdio' as const, ...playwrightMcp } }
          : {}),
        ...(s.mcpServers as Options['mcpServers']),
      },
      allowedTools: [...CLOUDE_READONLY_TOOLS, ...allowed],
      canUseTool: this.canUseTool,
      onElicitation: this.onElicitation,
      hooks: guardHooks(),
      stderr: (d) => {
        this.stderrTail.push(d);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      },
    };
    applyInfra(options, this.row); // model routing, sandboxes, semantic search — see server/src/infra
    applyCompaction(options); // after routing, so a provider's own compaction window still wins

    const q = query({ prompt: input, options });
    this.q = q;
    this.input = input;
    this.abort = abort;
    this.resumedRun = !!this.row.started;
    this.stderrTail = [];
    this.save({ status: 'starting', last_error: null });
    void this.consume(q);
  }

  private async consume(q: Query) {
    try {
      for await (const msg of q) this.handle(msg);
    } catch (err) {
      if (!this.abort?.signal.aborted) {
        const detail = this.stderrTail.join('').trim().split('\n').slice(-5).join('\n');
        let message = `${err instanceof Error ? err.message : String(err)}${detail ? `\n${detail}` : ''}`;
        // If Claude's transcript is gone (deleted ~/.claude, new server), stop retrying `resume`
        // forever: the next message starts a fresh conversation under the same session id.
        if (this.resumedRun && /no conversation found|conversation .*not found|session .*not found/i.test(message)) {
          this.save({ started: 0 }, false);
          message += '\nThe previous conversation could not be restored. Your next message starts a fresh conversation (history above is kept for reference).';
        }
        this.record('error', { message });
        this.save({ status: 'error', last_error: message });
      }
    } finally {
      if (this.q === q) {
        this.q = null;
        this.input?.close();
        this.input = null;
        this.abort = null;
      }
      for (const id of [...this.pending.keys()]) this.settle(id, { decision: 'deny', message: 'Session ended' }, true);
      this.activity.clear();
      if (this.row.status !== 'error') this.save({ status: 'idle' });
      else hub.broadcast({ t: 'session', session: this.toJSON() });
    }
  }

  private live(data: unknown) {
    hub.toSession(this.id, { t: 'live', sessionId: this.id, data });
  }

  /** Leading edge goes out at once; anything else within the interval is coalesced into one trailing update. */
  private activityChanged() {
    if (this.activityTimer || this.disposed) return;
    const flush = () => {
      this.activityTimer = null;
      if (this.disposed) return;
      this.activitySentAt = Date.now();
      hub.broadcast({ t: 'session', session: this.toJSON() });
    };
    const wait = this.activitySentAt + ACTIVITY_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) flush();
    else this.activityTimer = setTimeout(flush, wait);
  }

  private handle(msg: SDKMessage) {
    this.activity.observe(msg);
    this.compaction.observe(msg);
    switch (msg.type) {
      case 'stream_event':
      case 'tool_progress':
        this.live(msg);
        return;

      case 'prompt_suggestion':
        this.info.suggestion = msg.suggestion;
        this.live(msg);
        return;

      case 'system': {
        if (msg.subtype === 'init') {
          this.info = {
            ...this.info,
            model: msg.model,
            cwd: msg.cwd,
            version: msg.claude_code_version,
            tools: msg.tools,
            slashCommands: msg.slash_commands,
            mcpServers: msg.mcp_servers,
            skills: msg.skills,
            agents: msg.agents,
          };
          if (!this.row.started) this.save({ started: 1 }, false);
          if (this.row.permission_mode !== msg.permissionMode) this.save({ permission_mode: msg.permissionMode }, false);
          if (this.row.status === 'starting') this.save({ status: 'running' });
          void this.refreshCommands();
          this.record('sdk', msg);
          return;
        }
        if (msg.subtype === 'session_state_changed') {
          if (msg.state === 'running' && this.row.status !== 'awaiting_input') this.setStatus('running');
          return;
        }
        if (msg.subtype === 'status') {
          if (msg.permissionMode && msg.permissionMode !== this.row.permission_mode) this.save({ permission_mode: msg.permissionMode });
          this.live(msg);
          return;
        }
        if (PERSISTED_SYSTEM_SUBTYPES.has(msg.subtype)) this.record('sdk', msg);
        else this.live(msg);
        return;
      }

      case 'user':
        if (msg.uuid && this.ownUuids.delete(msg.uuid)) return; // echo of what we sent
        this.record('sdk', msg);
        return;

      case 'assistant':
        this.record('sdk', msg);
        if (msg.error === 'authentication_failed') this.authProblem = true;
        return;

      case 'result': {
        this.record('sdk', msg);
        let lastError = msg.is_error ? (msg.subtype === 'success' ? msg.result : msg.errors?.join('\n') || msg.subtype) : null;
        if (lastError && (this.authProblem || /not logged in|invalid api key|authentication/i.test(lastError))) {
          lastError = AUTH_HELP;
          hub.broadcast({ t: 'notify', level: 'error', title: 'Claude is not authenticated', body: 'Open Settings → Claude account', sessionId: this.id });
        }
        this.authProblem = false;
        // modelUsage is a running total (and may already include a resumed transcript's
        // history), so the ledger books only the delta since the last snapshot.
        const { snapshot, costDelta } = recordTurn(this.id, this.row.project_id, this.row.usage_snapshot, msg.modelUsage);
        this.save({
          status: this.pending.size ? 'awaiting_input' : 'idle',
          total_cost_usd: this.row.total_cost_usd + costDelta,
          usage_snapshot: snapshot,
          last_error: lastError,
        });
        this.refreshPlanUsage();
        this.scheduleIdleShutdown();
        return;
      }

      case 'conversation_reset':
        // /clear (and friends) restart the SDK's running totals at zero; so does our baseline.
        this.save({ usage_snapshot: '{}' }, false);
        this.live(msg);
        return;

      case 'rate_limit_event':
        ingestRateLimitEvent(msg.rate_limit_info);
        this.live(msg);
        return;

      default:
        this.live(msg);
    }
  }

  /** Best-effort plan-limit refresh via the SDK's experimental /usage request (at most once a minute, server-wide). */
  private refreshPlanUsage() {
    const q = this.q as (Query & { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<unknown> }) | null;
    if (!q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET || Date.now() - lastPlanUsageAt < 60_000) return;
    lastPlanUsageAt = Date.now();
    q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).then(ingestUsageResponse, () => {});
  }

  /** Free memory for sessions nobody is using; they resume transparently. */
  private scheduleIdleShutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const minutes = settings.get().idleTimeoutMinutes;
    if (!minutes || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.row.status === 'idle' && this.pending.size === 0 && !this.compaction.busy) this.stop();
    }, minutes * 60_000);
  }

  /** A compaction between turns has no `result` to end it: drop its activity line and re-arm the idle timer it held off. */
  private compactionSettled() {
    if (this.row.status !== 'idle') return;
    this.activity.clear();
    this.scheduleIdleShutdown();
  }

  // ---- permissions & questions ---------------------------------------------------

  private ask(req: PermissionRequest, signal: AbortSignal): Promise<PermissionResponse> {
    return new Promise((resolve) => {
      this.pending.set(req.id, { req, resolve });
      this.record('permission_request', req);
      this.broadcastPending();
      this.setStatus('awaiting_input');
      hub.broadcast({
        t: 'notify',
        level: 'warning',
        title: req.kind === 'question' ? 'Claude has a question' : `Approve ${req.toolName}?`,
        body: this.row.title,
        sessionId: this.id,
      });
      signal.addEventListener('abort', () => this.settle(req.id, { decision: 'deny', message: 'Cancelled' }, true), { once: true });
    });
  }

  private settle(requestId: string, response: PermissionResponse, cancelled = false): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.record('permission_resolved', {
      id: requestId,
      decision: response.decision,
      message: response.message,
      answers: response.answers,
      remember: response.remember,
      cancelled,
    });
    this.broadcastPending();
    if (this.pending.size === 0 && this.row.status === 'awaiting_input') this.setStatus(this.alive ? 'running' : 'idle');
    p.resolve(response);
    return true;
  }

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool';
    const req: PermissionRequest = {
      id: crypto.randomUUID(),
      sessionId: this.id,
      kind,
      toolName,
      toolUseId: opts.toolUseID,
      input,
      title: opts.title,
      description: opts.description ?? opts.decisionReason,
      decisionReason: opts.decisionReason,
      blockedPath: opts.blockedPath,
      canRemember: kind === 'tool' && !opts.suppressAlwaysAllowRule,
      createdAt: now(),
    };
    const response = await this.ask(req, opts.signal);

    if (response.decision === 'deny') {
      return { behavior: 'deny', message: response.message?.trim() || 'The user declined this action.', toolUseID: opts.toolUseID };
    }
    if (kind === 'question') {
      return { behavior: 'allow', updatedInput: { ...input, answers: response.answers ?? {} }, toolUseID: opts.toolUseID };
    }
    if (kind === 'plan') {
      // "remember" on a plan approval means: approve and auto-accept the edits that follow.
      const result: PermissionResult = { behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID };
      if (response.remember) {
        result.updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
        this.save({ permission_mode: 'acceptEdits' });
      }
      return result;
    }

    const result: PermissionResult = { behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID };
    if (response.remember) {
      const updates: PermissionUpdate[] = opts.suggestions?.length
        ? opts.suggestions
        : [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
      result.updatedPermissions = updates;
      // Persist allow rules so they survive the process being recycled.
      const allowed = new Set<string>(JSON.parse(this.row.allowed_tools || '[]'));
      for (const u of updates) if (u.type === 'addRules' && u.behavior === 'allow') u.rules.forEach((r) => allowed.add(ruleToString(r)));
      this.save({ allowed_tools: JSON.stringify([...allowed]) }, false);
    }
    return result;
  };

  private onElicitation: OnElicitation = async (request, { signal }) => {
    const req: PermissionRequest = {
      id: crypto.randomUUID(),
      sessionId: this.id,
      kind: 'elicitation',
      toolName: `mcp:${request.serverName}`,
      input: request as unknown as Record<string, unknown>,
      title: request.title ?? request.message,
      description: request.description,
      canRemember: false,
      createdAt: now(),
    };
    const response = await this.ask(req, signal);
    if (response.decision === 'deny') return { action: 'decline' };
    return { action: 'accept', ...(response.content ? { content: response.content as Record<string, string | number | boolean> } : {}) };
  };

  async destroy() {
    this.disposed = true; // a trailing activity update must not resurrect a deleted session in the browsers
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.stop();
    const project = projects.get(this.row.project_id);
    if (this.row.started && project) await deleteClaudeTranscript(this.id, { dir: project.path }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------

export const KNOWN_MODELS = [
  { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Default — strongest all-round coding model' },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable, for the hardest long-horizon work' },
  { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Fast and capable for everyday coding' },
  { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest and cheapest' },
  { value: 'claude-opus-5', displayName: 'Opus 5', description: 'Previous Opus' },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Previous Sonnet' },
];

class SessionManager {
  private sessions = new Map<string, AgentSession>();

  constructor() {
    // A server restart kills every Claude process; reflect that in the rows.
    db.prepare(`UPDATE sessions SET status = 'idle' WHERE status IN ('running', 'starting', 'awaiting_input')`).run();
  }

  get(id: string): AgentSession {
    let s = this.sessions.get(id);
    if (s) return s;
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined;
    if (!row) throw new HttpError(404, 'Session not found');
    s = new AgentSession(row);
    this.sessions.set(id, s);
    return s;
  }

  list(projectId?: string, includeArchived = false): Session[] {
    const rows = (
      projectId
        ? db.prepare('SELECT id FROM sessions WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
        : db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC').all()
    ) as { id: string }[];
    return rows.map((r) => this.get(r.id).toJSON()).filter((s) => includeArchived || !s.archived);
  }

  create(projectId: string, opts: { title?: string; model?: string | null; permissionMode?: PermissionMode; effort?: EffortLevel | null }): AgentSession {
    projects.require(projectId);
    const s = settings.get();
    const id = crypto.randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO sessions (id, project_id, title, model, permission_mode, effort, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    ).run(
      id,
      projectId,
      opts.title?.trim() || 'New session',
      opts.model ?? s.defaultModel,
      opts.permissionMode ?? s.defaultPermissionMode,
      opts.effort ?? s.defaultEffort,
      t,
      t,
    );
    const session = this.get(id);
    hub.broadcast({ t: 'session', session: session.toJSON() });
    return session;
  }

  async delete(id: string) {
    const s = this.get(id);
    await s.destroy();
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.sessions.delete(id);
    hub.broadcast({ t: 'session_deleted', sessionId: id });
  }

  activeCount() {
    return [...this.sessions.values()].filter((s) => s.alive).length;
  }

  stopAll() {
    for (const s of this.sessions.values()) s.stop();
  }

  /** Every open prompt, by session. Only in-memory sessions can have one (prompts die with their process). */
  pendingSnapshot(): Record<string, PermissionRequest[]> {
    const out: Record<string, PermissionRequest[]> = {};
    for (const s of this.sessions.values()) {
      const requests = s.pendingRequests();
      if (requests.length) out[s.id] = requests;
    }
    return out;
  }
}

export const sessions = new SessionManager();
