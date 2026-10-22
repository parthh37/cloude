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
  archived: boolean;
  totalCostUsd: number;
  lastSeq: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
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
  | { t: 'error'; message: string };

export type ClientMessage =
  | { t: 'sub'; sessionId: string; after: number }
  | { t: 'unsub'; sessionId: string }
  | { t: 'ping' };
