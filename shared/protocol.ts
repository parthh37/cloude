// Shared contract between the Cloude server and the web client.
// Both sides import this file directly (no build step), so keep it type-only.

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
  archived: boolean;
  totalCostUsd: number;
  lastSeq: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** Set when the session works in its own git worktree (isolated from other sessions). */
  worktree?: Worktree | null;
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
  | { t: 'services'; services: ServiceState[] }
  | { t: 'routes'; routes: Route[] }
  | { t: 'tunnels'; tunnels: Tunnel[] }
  | { t: 'notify'; level: 'info' | 'success' | 'warning' | 'error'; title: string; body?: string; sessionId?: string }
  | { t: 'error'; message: string }
  | WorkbenchMessage;

export type ClientMessage =
  | { t: 'sub'; sessionId: string; after: number }
  | { t: 'unsub'; sessionId: string }
  | { t: 'ping' };

// ---- Workbench: isolation, board, agent CLIs, memory, compression, desktop ----

/** How a new session (or board card run) relates to the project's files. */
export type Isolation = 'shared' | 'worktree';

/**
 * A git worktree Cloude created inside the project at `.cloude/worktrees/<id>`,
 * on its own branch. Sessions in different worktrees can edit, build and run
 * the same project at the same time without touching each other's files.
 *
 * Files/Git/Terminal endpoints accept a *scope id* in place of a project id:
 * `<projectId>~<worktreeId>` targets the worktree instead of the main checkout.
 */
export interface Worktree {
  id: string; // slug, unique within the project
  projectId: string;
  path: string; // absolute
  relPath: string; // relative to the project root
  branch: string;
  baseBranch: string;
  ownerType: 'session' | 'terminal' | 'card' | 'manual';
  ownerId: string | null;
  createdAt: number;
}

export interface WorktreeStatus {
  worktree: Worktree;
  exists: boolean;
  ahead: number; // commits on the branch that the base doesn't have
  behind: number; // commits on the base that the branch doesn't have
  dirty: number; // uncommitted files in the worktree
  merged: boolean; // branch is fully contained in the base
  conflicts: string[]; // unresolved files when a sync left a merge in progress
  files: { path: string; added: number; removed: number }[]; // committed diff vs base
}

export type BoardColumn = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type BoardPriority = 'low' | 'medium' | 'high' | 'urgent';
export type CardRunStatus = 'running' | 'needs_input' | 'succeeded' | 'failed' | 'stopped';

export interface BoardCard {
  id: string;
  projectId: string;
  title: string;
  description: string;
  column: BoardColumn;
  position: number;
  priority: BoardPriority;
  labels: string[];
  /** 'claude' (Agent SDK session) or the id of an agent CLI. */
  agent: string;
  isolation: Isolation;
  sessionId: string | null;
  terminalId: string | null;
  worktreeId: string | null;
  runStatus: CardRunStatus | null;
  createdAt: number;
  updatedAt: number;
}

/** A coding-agent CLI Cloude can launch in a terminal or run headless for a board card. */
export interface AgentCli {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  /** Interactive launch command (run in a PTY). */
  command: string;
  /** Non-interactive command; `{prompt}` is replaced with the shell-quoted task. Null = interactive only. */
  headless: string | null;
  /** Shell command that installs the CLI. */
  install: string | null;
  /** Binary looked up on PATH to decide whether it's installed. */
  bin: string;
  /** Environment variables (Cloude secrets) the CLI authenticates with. */
  envKeys: string[];
  docsUrl: string | null;
  installed: boolean;
  version: string | null;
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface Memory {
  id: string;
  projectId: string | null; // null = shared by every project
  name: string;
  description: string;
  content: string;
  type: MemoryType;
  createdAt: number;
  updatedAt: number;
}

export type CompressionLevel = 'off' | 'balanced' | 'aggressive';

export interface CompressionStats {
  calls: number; // tool results that were compressed
  originalChars: number;
  compressedChars: number;
}

/** Feature settings for the workbench extensions (kept apart from AppSettings). */
export interface WorkbenchSettings {
  compression: CompressionLevel;
  defaultIsolation: Isolation;
  injectMemory: boolean;
  desktop: { width: number; height: number; autoStart: boolean };
}

export interface DesktopStatus {
  available: boolean;
  missing: string[]; // binaries that must be installed for the desktop to work
  running: boolean;
  display: string | null; // e.g. ":99"
  width: number;
  height: number;
  error: string | null;
  /** VNC password for noVNC; only present in the API response, never broadcast. */
  password?: string;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: 'code' | 'data' | 'browser' | 'productivity' | 'reasoning' | 'cloud';
  /** Value written to AppSettings.mcpServers[id]. `${VAR}` is filled from Cloude secrets at session start. */
  config: Record<string, unknown>;
  envKeys: string[];
  docsUrl: string;
}

export type WorkbenchMessage =
  | { t: 'board'; projectId: string; cards: BoardCard[] }
  | { t: 'worktrees'; projectId: string; worktrees: Worktree[] }
  | { t: 'desktop'; status: DesktopStatus };
