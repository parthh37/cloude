// Shared contract between the Cloude server and the web client.
// Both sides import this file directly (no build step), so keep it type-only.
// Sandboxes, storage cleaner, model routing and embeddings live in ./infra.ts.
export type * from './infra.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type SessionStatus =
  | 'idle' // process may or may not be alive; ready for input
  | 'starting' // spawning the Claude process
  | 'running' // a turn is in progress
  | 'awaiting_input' // blocked on a permission / question from the user
  | 'error';

export interface Project {
  id: string;
  name: string;
  slug: string;
  path: string;
  gitUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string; // identical to the Claude Code session UUID
  projectId: string;
  title: string;
  model: string | null;
  permissionMode: PermissionMode;
  effort: EffortLevel | null;
  status: SessionStatus;
  started: boolean; // true once Claude has created its transcript (resume possible)
  alive: boolean; // whether a Claude process is currently attached
  activity: SessionActivity | null; // what Claude is doing right now (live only, null between turns)
  archived: boolean;
  totalCostUsd: number;
  lastSeq: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One line of "what is Claude doing?" for views that watch many sessions at
 * once (board, dashboard, session list). Summarised from the SDK stream on the
 * server and broadcast at most about once a second per session; the full
 * stream stays subscriber-only.
 */
export interface SessionActivity {
  kind: 'thinking' | 'writing' | 'tool' | 'agent' | 'compacting';
  label: string; // "Editing", "Thinking", "Agent · Explore"
  detail?: string; // target: a path, a command, a subagent's current step
  tool?: string; // tool name, for 'tool' and 'agent'
  since: number; // when this step began (ms); clients derive elapsed time from it
}

export interface ImageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string; // base64, no data: prefix
  name?: string;
}

/** A persisted, replayable entry in a session's timeline. */
export interface SessionEvent {
  seq: number;
  sessionId: string;
  kind: SessionEventKind;
  data: any;
  createdAt: number;
}

export type SessionEventKind =
  | 'user' // text typed by the user in the web UI ({text, images})
  | 'sdk' // raw SDKMessage from the Agent SDK (assistant, user/tool_result, system, result, ...)
  | 'permission_request' // PermissionRequest
  | 'permission_resolved' // {id, decision, message?}
  | 'error'; // {message}

export type PermissionRequestKind = 'tool' | 'question' | 'elicitation' | 'plan';

export interface PermissionRequest {
  id: string;
  sessionId: string;
  kind: PermissionRequestKind;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  canRemember: boolean;
  createdAt: number;
}

export interface PermissionResponse {
  decision: 'allow' | 'deny';
  /** Persist an "always allow" rule for this tool for the rest of the session. */
  remember?: boolean;
  /** Feedback shown to Claude on deny. */
  message?: string;
  /** For AskUserQuestion: question text -> chosen label(s). */
  answers?: Record<string, string>;
  /** For MCP elicitation forms. */
  content?: Record<string, unknown>;
}

export interface ServiceDef {
  id: string;
  projectId: string;
  name: string;
  kind: 'dev' | 'deploy';
  strategy: 'process' | 'docker' | 'static';
  command: string; // process: shell command; docker: extra `docker run` args; static: directory
  cwd: string; // relative to project root
  port: number | null;
  env: Record<string, string>;
  autoRestart: boolean;
  createdAt: number;
}

export interface ServiceState extends ServiceDef {
  status: 'stopped' | 'starting' | 'running' | 'crashed' | 'building';
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  restarts: number;
  urls: { private?: string; public?: string };
}

export interface Route {
  id: string;
  label: string; // subdomain label, e.g. "myapp" -> myapp.<preview domain>
  hostname: string | null; // optional custom domain
  targetType: 'port' | 'static';
  port: number | null;
  staticDir: string | null;
  isPublic: boolean;
  projectId: string | null;
  createdAt: number;
  url: string;
}

export interface ListeningPort {
  port: number;
  pid: number | null;
  command: string | null;
  address: string;
  previewUrl: string;
}

export interface Tunnel {
  id: string;
  port: number;
  url: string | null;
  status: 'starting' | 'running' | 'error' | 'stopped';
  error: string | null;
  createdAt: number;
}

export interface TerminalInfo {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  createdAt: number;
  alive: boolean;
}

export interface FileEntry {
  name: string;
  path: string; // relative to project root
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: { path: string; index: string; worktree: string }[];
}

export interface AppSettings {
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  defaultEffort: EffortLevel | null;
  appendSystemPrompt: string;
  enablePlaywright: boolean;
  mcpServers: Record<string, unknown>; // extra MCP servers (stdio/http/sse configs)
  idleTimeoutMinutes: number;
  /** Spend caps in USD (UTC day / UTC calendar month). null = no cap. */
  budgetDailyUsd: number | null;
  budgetMonthlyUsd: number | null;
  /** Notify when a cap is this % used. */
  budgetWarnPercent: number;
  /** Refuse new messages once a cap is reached (running turns are never cut off). */
  budgetEnforce: boolean;
  /** Sign a device out after this many days without activity. */
  sessionIdleDays: number;
}

// ---- Auth & security ---------------------------------------------------------

export interface AuthUser {
  id: string;
  username: string;
}

export type AuthMethod = 'password' | 'totp' | 'recovery' | 'passkey';

/** POST /api/auth/login: either signed in, or a second factor is needed. */
export interface LoginResponse {
  user?: AuthUser;
  mfa?: { ticket: string; methods: { totp: boolean; passkey: boolean; recovery: boolean } };
}

export interface DeviceSession {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  /** Earlier of the absolute expiry and the idle expiry. */
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  method: AuthMethod;
}

export interface Passkey {
  id: string;
  name: string;
  deviceType: 'synced' | 'device-bound';
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface SecurityOverview {
  totp: boolean;
  recoveryCodesLeft: number;
  passkeys: Passkey[];
  sessions: DeviceSession[];
  passwordChangedAt: number | null;
}

export type SecurityEventType =
  | 'login_success'
  | 'login_failure'
  | 'mfa_failure'
  | 'lockout'
  | 'logout'
  | 'session_revoked'
  | 'password_changed'
  | 'totp_enabled'
  | 'totp_disabled'
  | 'recovery_codes_generated'
  | 'recovery_code_used'
  | 'passkey_added'
  | 'passkey_removed'
  | 'passkey_login'
  | 'reauth_failure';

export interface SecurityEvent {
  id: number;
  type: SecurityEventType;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown> | null;
  createdAt: number;
}

// ---- Usage ------------------------------------------------------------------

export interface UsageTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Ledger rows: one per (turn, model). */
  turns: number;
}

export type UsageRange = '24h' | '7d' | '30d' | '90d';

export interface UsageReport {
  range: UsageRange;
  from: number;
  to: number;
  bucket: 'hour' | 'day';
  totals: UsageTotals;
  /** Same-length window immediately before `from`, for deltas. */
  previous: UsageTotals;
  series: { t: number; costUsd: number; tokens: number; byModel: Record<string, number> }[];
  models: (UsageTotals & { model: string })[];
  projects: (UsageTotals & { projectId: string; name: string | null })[];
  sessions: (UsageTotals & { sessionId: string; projectId: string; title: string | null; lastAt: number })[];
}

export interface UsageEventRow {
  id: number;
  at: number;
  sessionId: string;
  projectId: string;
  title: string | null;
  model: string;
  costUsd: number;
  tokens: number;
}

export interface RateLimitWindow {
  kind: string; // e.g. 'five_hour', 'seven_day', 'seven_day_opus'
  label: string;
  percent: number | null; // 0-100
  resetsAt: number | null;
  severity: 'normal' | 'warning' | 'critical';
}

/** Claude subscription (Pro/Max) plan limits. Unavailable for API keys. */
export interface RateLimitState {
  available: boolean;
  subscription: string | null;
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
  windows: RateLimitWindow[];
  updatedAt: number | null;
}

export interface BudgetPeriod {
  period: 'day' | 'month';
  spentUsd: number;
  limitUsd: number | null;
  percent: number | null;
  state: 'ok' | 'warn' | 'over';
  resetsAt: number;
}

export interface UsageLive {
  today: UsageTotals;
  month: UsageTotals;
  budget: { day: BudgetPeriod; month: BudgetPeriod; enforce: boolean; warnPercent: number };
  limits: RateLimitState;
  recent: UsageEventRow[];
}

// ---- Server health ------------------------------------------------------------

export interface MetricsSample {
  t: number;
  cpu: number; // 0-100, all cores
  load: [number, number, number];
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  netRx: number | null; // bytes/s, null where unsupported
  netTx: number | null;
}

export interface ProcessGroup {
  kind: 'server' | 'agents' | 'terminals' | 'service';
  label: string;
  serviceId?: string;
  projectId?: string;
  processes: number;
  cpu: number; // % of one core, summed (may exceed 100)
  rss: number;
}

export interface HostInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  cpuModel: string;
  uptime: number; // seconds
  processUptime: number; // seconds
  nodeVersion: string;
}

export interface MetricsSnapshot {
  host: HostInfo;
  intervalMs: number;
  history: MetricsSample[];
  processes: ProcessGroup[];
}

export interface SystemStatus {
  version: string;
  claudeAuth: { configured: boolean; source: 'api_key' | 'oauth_token' | 'cli_login' | 'none' };
  publicUrl: string;
  previewDomain: string | null;
  previewMode: 'subdomain' | 'path';
  toolchains: Record<string, string | null>;
  disk: { total: number; free: number } | null;
  activeSessions: number;
}

export interface SecretEntry {
  key: string;
  projectId: string | null;
  preview: string; // masked
  updatedAt: number;
}

// ---- WebSocket messages ----------------------------------------------------

export type ServerMessage =
  | { t: 'hello'; serverTime: number }
  | { t: 'event'; event: SessionEvent }
  | { t: 'live'; sessionId: string; data: any } // ephemeral (stream deltas, tool progress)
  | { t: 'session'; session: Session }
  | { t: 'session_deleted'; sessionId: string }
  | { t: 'pending'; sessionId: string; requests: PermissionRequest[] }
  | { t: 'pending_all'; pending: Record<string, PermissionRequest[]> } // on connect: every open prompt, so boards show questions asked before the page loaded
  | { t: 'services'; services: ServiceState[] }
  | { t: 'routes'; routes: Route[] }
  | { t: 'tunnels'; tunnels: Tunnel[] }
  | { t: 'notify'; level: 'info' | 'success' | 'warning' | 'error'; title: string; body?: string; sessionId?: string }
  | { t: 'usage'; usage: UsageLive }
  | { t: 'metrics'; sample: MetricsSample; processes: ProcessGroup[] } // only to clients watching 'metrics'
  | { t: 'error'; message: string };

export type ClientMessage =
  | { t: 'sub'; sessionId: string; after: number }
  | { t: 'unsub'; sessionId: string }
  | { t: 'watch'; topic: 'metrics' | 'processes'; on: boolean } // metrics = system sample; processes = per-process breakdown (costlier)
  | { t: 'ping' };
