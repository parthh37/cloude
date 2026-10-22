// Infrastructure contract: sandboxes (disposable machines Claude fully controls),
// the storage cleaner, model/provider routing, and embeddings.
// Re-exported from protocol.ts — import these types from there. Type-only.

import type { EffortLevel } from './protocol.js';

// ---- Sandboxes ---------------------------------------------------------------

/**
 * How strongly a sandbox is separated from the host. Each level maps to an OCI
 * runtime on the Docker host; unavailable levels are reported, never faked.
 *   container — runc: a normal container, root inside, fastest
 *   gvisor    — runsc: user-space kernel, syscalls never reach the host kernel
 *   system    — sysbox-runc: full OS (systemd, Docker-in-Docker) without --privileged
 *   microvm   — kata: a real VM with its own kernel (needs /dev/kvm)
 */
export type SandboxIsolation = 'container' | 'gvisor' | 'system' | 'microvm';

export type SandboxStatus = 'creating' | 'running' | 'stopped' | 'error' | 'destroying';

/**
 * What the sandbox sees of the project:
 *   copy — a private copy at /workspace (default: the sandbox can't touch the host checkout)
 *   ro   — the live project, read-only
 *   rw   — the live project, read-write (asks the user first)
 *   none — empty machine
 */
export type SandboxMount = 'copy' | 'ro' | 'rw' | 'none';

export interface SandboxPort {
  container: number;
  host: number; // auto-allocated on 127.0.0.1 — never collides with other sandboxes or services
  previewUrl: string;
}

export interface SandboxLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
}

export interface SandboxSnapshot {
  id: string;
  sandboxId: string;
  label: string;
  image: string;
  sizeBytes: number | null;
  createdAt: number;
}

export interface Sandbox {
  id: string;
  name: string; // unique per project; also the hostname other sandboxes in the project reach it by
  projectId: string;
  sessionId: string | null; // owner — when that session's work is done the sandbox is reclaimed
  image: string;
  isolation: SandboxIsolation;
  runtime: string; // OCI runtime actually used
  status: SandboxStatus;
  error: string | null;
  container: string; // docker container name
  network: 'project' | 'isolated';
  ports: SandboxPort[];
  limits: SandboxLimits;
  mount: SandboxMount;
  shell: string; // bash or sh, detected at creation
  pinned: boolean; // never auto-reclaimed
  ttlMinutes: number | null; // idle minutes before automatic reclaim (null = policy default)
  lastActiveAt: number;
  createdAt: number;
  sizeBytes: number | null; // writable layer, last measured
  snapshots: SandboxSnapshot[];
}

export interface SandboxCreateInput {
  name: string;
  projectId: string;
  sessionId?: string | null;
  image?: string;
  isolation?: SandboxIsolation;
  ports?: number[];
  mount?: SandboxMount;
  network?: 'project' | 'isolated';
  cpus?: number;
  memoryMb?: number;
  env?: Record<string, string>;
  ttlMinutes?: number | null;
  pinned?: boolean;
  /** Command run once after the machine boots (e.g. installing packages). */
  init?: string;
}

export interface SandboxIsolationInfo {
  id: SandboxIsolation;
  available: boolean;
  runtime: string | null;
  note: string;
}

export interface SandboxRuntimeInfo {
  available: boolean;
  reason: string | null; // why sandboxes are unavailable
  engine: string | null; // e.g. "Docker 28.3.3 on Docker Desktop"
  isolations: SandboxIsolationInfo[];
  kvm: boolean;
  instance: string; // tag isolating this Cloude install's resources on a shared Docker host
  images: { image: string; label: string }[];
  quota: { perProject: number; total: number; used: number };
}

export interface SandboxExecResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

// ---- Storage cleaner -----------------------------------------------------------

export type CleanerCategory =
  | 'sandboxes' // finished / expired / orphaned sandboxes
  | 'snapshots' // snapshot images beyond the keep count or of deleted sandboxes
  | 'docker' // Cloude-labelled stopped containers, unused networks/volumes, dangling Cloude images
  | 'docker_global' // host-wide dangling images + old build cache (affects non-Cloude projects)
  | 'tmp' // Cloude/Playwright temp files
  | 'caches' // package-manager caches (npm, pnpm, pip, uv, go, cargo, …)
  | 'artifacts'; // node_modules/.venv/target/… in long-idle projects (never with deployments)

/** off = never; schedule = every scheduled run; pressure = only when the disk is running low. */
export type CleanerTrigger = 'off' | 'schedule' | 'pressure';

export interface CleanerPolicy {
  enabled: boolean;
  intervalMinutes: number;
  /** Disk-pressure threshold: free space below this percentage (or below minFreeGb). */
  minFreePercent: number;
  minFreeGb: number;
  categories: Record<CleanerCategory, CleanerTrigger>;
  /** Default idle minutes before an unpinned sandbox is stopped, then destroyed. */
  sandboxIdleStopMinutes: number;
  sandboxIdleDestroyMinutes: number;
  /** Reclaim a session's sandboxes this many minutes after its work is done (session idle/ended/archived/deleted). */
  sessionDoneGraceMinutes: number;
  snapshotKeep: number;
  artifactIdleDays: number;
  tmpMaxAgeHours: number;
}

export interface CleanerItem {
  category: CleanerCategory;
  id: string; // stable identifier (path, container, image…)
  label: string;
  bytes: number | null;
  reason: string;
}

export interface CleanerCategoryReport {
  category: CleanerCategory;
  label: string;
  description: string;
  trigger: CleanerTrigger;
  bytes: number;
  items: CleanerItem[];
}

export interface CleanerRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  trigger: 'manual' | 'schedule' | 'pressure' | 'work_done';
  freedBytes: number;
  removed: number;
  errors: string[];
  byCategory: Partial<Record<CleanerCategory, number>>;
}

export interface StorageReport {
  disk: { path: string; total: number; free: number } | null;
  pressure: boolean;
  scannedAt: number | null;
  categories: CleanerCategoryReport[];
  runs: CleanerRun[];
  running: boolean;
  policy: CleanerPolicy;
}

// ---- Model & provider routing ---------------------------------------------------

/**
 * Where a Claude Code process sends its requests.
 *   anthropic — the Claude account from Settings (API key or subscription)
 *   bedrock / vertex / foundry — Claude on a cloud provider
 *   gateway — any Anthropic-compatible endpoint (LiteLLM, OpenRouter, your own proxy)
 *   ollama — a local/remote Ollama server (Anthropic-compatible API)
 */
export type ProviderKind = 'anthropic' | 'bedrock' | 'vertex' | 'foundry' | 'gateway' | 'ollama';

export interface ModelProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  /** Name of a Cloude secret holding the credential (never the credential itself). */
  authSecret: string | null;
  authStyle: 'bearer' | 'x-api-key';
  region: string | null; // bedrock / vertex
  cloudProject: string | null; // vertex project id
  resource: string | null; // foundry resource
  extraEnv: Record<string, string>;
  models: string[];
  builtin: boolean;
}

export type TaskKind = 'general' | 'plan' | 'code' | 'debug' | 'review' | 'test' | 'ui' | 'infra' | 'docs' | 'quick' | 'research';

export interface TaskKindInfo {
  id: TaskKind;
  label: string;
  hint: string;
}

export interface ModelRoute {
  providerId: string;
  model: string;
  effort: EffortLevel | null;
  fallbackModel: string | null;
}

/** Model slots inside one Claude process (applied when they use the same provider as the main route). */
export interface RoleRoutes {
  subagent: { providerId: string; model: string } | null;
  background: { providerId: string; model: string } | null;
}

export interface RoutingConfig {
  enabled: boolean;
  /** Guess the task from the session's first message when no #tag or manual task is set. */
  autoClassify: boolean;
  routes: Partial<Record<TaskKind, ModelRoute | null>>;
  roles: RoleRoutes;
  providers: ModelProvider[];
}

export interface RoutingDecision {
  sessionId: string;
  sessionTitle: string | null;
  task: TaskKind;
  source: 'manual' | 'tag' | 'classifier' | 'default';
  providerId: string;
  model: string;
  applied: boolean;
  reason: string;
  at: number;
}

export interface ProviderCheck {
  ok: boolean;
  message: string;
  models: string[];
}

// ---- Embeddings -------------------------------------------------------------------

export type EmbeddingProviderKind = 'local' | 'ollama' | 'voyage' | 'gemini' | 'jina' | 'mistral' | 'openai';

export interface EmbeddingConfig {
  mode: 'auto' | 'manual';
  provider: EmbeddingProviderKind | null;
  model: string | null;
  baseUrl: string | null; // ollama / openai-compatible
  secret: string | null; // Cloude secret name for hosted providers
}

export interface EmbeddingCandidate {
  provider: EmbeddingProviderKind;
  model: string;
  available: boolean;
  free: boolean;
  private: boolean; // text never leaves the server
  detail: string;
}

export interface EmbeddingStatus {
  config: EmbeddingConfig;
  active: { provider: EmbeddingProviderKind; model: string; dimensions: number | null; free: boolean; private: boolean } | null;
  state: 'unconfigured' | 'detecting' | 'installing' | 'ready' | 'error';
  message: string | null;
  candidates: EmbeddingCandidate[];
  detectedAt: number | null;
  index: { projects: number; files: number; chunks: number };
}

export interface SemanticHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
}

// ---- Overview ------------------------------------------------------------------------

export interface InfraOverview {
  runtime: SandboxRuntimeInfo;
  sandboxes: Sandbox[];
  storage: StorageReport;
  routing: RoutingConfig;
  taskKinds: TaskKindInfo[];
  decisions: RoutingDecision[];
  embeddings: EmbeddingStatus;
}
