import { create } from 'zustand';
import type { AgentCli, BoardCard, DesktopStatus, Project, ServerMessage, Session, WorkbenchSettings, Worktree } from '../../../shared/protocol';
import { api } from './api';

/** Client state for the workbench extensions (board, worktrees, desktop, agent CLIs). */
interface WorkbenchState {
  boards: Record<string, BoardCard[]>; // projectId -> cards
  worktrees: Record<string, Worktree[]>; // projectId -> worktrees
  desktop: DesktopStatus | null;
  clis: AgentCli[] | null;
  settings: WorkbenchSettings | null;
}

export const useWorkbench = create<WorkbenchState>(() => ({
  boards: {},
  worktrees: {},
  desktop: null,
  clis: null,
  settings: null,
}));

/** Messages the core store doesn't handle land here; anything unknown is ignored. */
export function handleWorkbenchMessage(msg: ServerMessage) {
  switch (msg.t) {
    case 'board':
      useWorkbench.setState((s) => ({ boards: { ...s.boards, [msg.projectId]: msg.cards } }));
      break;
    case 'worktrees':
      useWorkbench.setState((s) => ({ worktrees: { ...s.worktrees, [msg.projectId]: msg.worktrees } }));
      break;
    case 'desktop':
      useWorkbench.setState({ desktop: msg.status });
      break;
  }
}

export async function loadBoard(projectId: string) {
  const { cards } = await api.get<{ cards: BoardCard[] }>(`/api/projects/${projectId}/board`);
  useWorkbench.setState((s) => ({ boards: { ...s.boards, [projectId]: cards } }));
}

export async function loadClis(fresh = false) {
  const { clis } = await api.get<{ clis: AgentCli[] }>(`/api/clis${fresh ? '?fresh=true' : ''}`);
  useWorkbench.setState({ clis });
  return clis;
}

export async function loadWorkbenchSettings() {
  const { settings } = await api.get<{ settings: WorkbenchSettings }>('/api/workbench');
  useWorkbench.setState({ settings });
  return settings;
}

/**
 * The Files / Git / Terminal panels address a "scope": the project itself, or
 * `<projectId>~<worktreeId>` when the selected session works in its own worktree.
 * Handing panels a project whose id is the scope id makes every existing panel
 * request target the right directory without the panels knowing about worktrees.
 */
export function scopedProject(project: Project, session: Session | undefined): Project {
  const wt = session?.worktree;
  return wt ? { ...project, id: `${project.id}~${wt.id}`, path: wt.path } : project;
}

export const ISOLATION_KEY = 'cloude.isolation';
