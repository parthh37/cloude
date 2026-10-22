import type { BoardCard, BoardColumn, BoardPriority, CardRunStatus, Isolation, Session } from '../../shared/protocol.js';
import { agentClis } from './agents/clis.js';
import { sessions } from './agent/session.js';
import { bus } from './bus.js';
import { newId } from './crypto.js';
import { db, now, tx } from './db.js';
import { hub } from './hub.js';
import { projects } from './projects.js';
import { ensureSchema, extSettings } from './schema.js';
import { terminals } from './terminal/terminals.js';
import { HttpError } from './util/paths.js';
import { worktrees } from './worktrees.js';

/**
 * Kanban board per project. A card is a unit of work that can be *run*: it
 * starts a Claude session (or a headless agent CLI) in its own worktree, and
 * the card follows the run — In progress → Review when the agent stops →
 * Done when its branch is merged.
 */

ensureSchema(
  'board-v1',
  `
  CREATE TABLE board_cards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    col TEXT NOT NULL DEFAULT 'backlog',
    position INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',
    labels TEXT NOT NULL DEFAULT '[]',
    agent TEXT NOT NULL DEFAULT 'claude',
    isolation TEXT NOT NULL DEFAULT 'worktree',
    session_id TEXT,
    terminal_id TEXT,
    worktree_id TEXT,
    run_status TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX board_cards_project ON board_cards(project_id, col, position);
  CREATE INDEX board_cards_session ON board_cards(session_id);
  `,
);

export const COLUMNS: BoardColumn[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];
const PRIORITIES: BoardPriority[] = ['low', 'medium', 'high', 'urgent'];

interface CardRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  col: BoardColumn;
  position: number;
  priority: BoardPriority;
  labels: string;
  agent: string;
  isolation: Isolation;
  session_id: string | null;
  terminal_id: string | null;
  worktree_id: string | null;
  run_status: CardRunStatus | null;
  created_at: number;
  updated_at: number;
}

const toCard = (r: CardRow): BoardCard => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  description: r.description,
  column: r.col,
  position: r.position,
  priority: r.priority,
  labels: JSON.parse(r.labels || '[]'),
  agent: r.agent,
  isolation: r.isolation,
  sessionId: r.session_id,
  terminalId: r.terminal_id,
  worktreeId: r.worktree_id,
  runStatus: r.run_status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function broadcast(projectId: string) {
  hub.broadcast({ t: 'board', projectId, cards: board.list(projectId) });
}

/** What the agent is asked to do when a card starts. */
function promptFor(card: BoardCard, isolated: boolean): string {
  return [
    `# Board task: ${card.title}`,
    card.description.trim() || '(No further description — infer the scope from the title and the codebase, and ask if it is ambiguous.)',
    '',
    '---',
    `This task comes from the project's Cloude board (card ${card.id}, priority ${card.priority}${card.labels.length ? `, labels: ${card.labels.join(', ')}` : ''}).`,
    isolated
      ? 'You are on your own branch in an isolated worktree; other agents are working on other cards in parallel.'
      : 'You are working directly in the main checkout.',
    'When you are done: run the relevant tests and type checks, commit your work with a clear message, and finish with a short summary of what changed and how you verified it.',
  ].join('\n');
}

/** Map a session's lifecycle onto its card. Returns null when nothing should change. */
function cardUpdateForSession(card: BoardCard, s: Session): Partial<Pick<BoardCard, 'column' | 'runStatus'>> | null {
  const runStatus: CardRunStatus | null =
    s.status === 'running' || s.status === 'starting'
      ? 'running'
      : s.status === 'awaiting_input'
        ? 'needs_input'
        : s.status === 'error'
          ? 'failed'
          : card.runStatus === 'running' || card.runStatus === 'needs_input'
            ? s.lastError
              ? 'failed'
              : 'succeeded'
            : card.runStatus;
  if (runStatus === card.runStatus) return null;
  const patch: Partial<Pick<BoardCard, 'column' | 'runStatus'>> = { runStatus };
  // An agent that stops cleanly hands the card to a human for review; never move a card backwards.
  if (runStatus === 'succeeded' && card.column === 'in_progress') patch.column = 'review';
  if (runStatus === 'running' && (card.column === 'backlog' || card.column === 'todo')) patch.column = 'in_progress';
  return patch;
}

export const board = {
  list(projectId: string): BoardCard[] {
    const rows = db.prepare('SELECT * FROM board_cards WHERE project_id = ? ORDER BY position, created_at').all(projectId) as unknown as CardRow[];
    return rows.map(toCard);
  },

  get(id: string): BoardCard {
    const r = db.prepare('SELECT * FROM board_cards WHERE id = ?').get(id) as unknown as CardRow | undefined;
    if (!r) throw new HttpError(404, 'Card not found');
    return toCard(r);
  },

  create(
    projectId: string,
    input: { title: string; description?: string; column?: BoardColumn; priority?: BoardPriority; labels?: string[]; agent?: string; isolation?: Isolation },
  ): BoardCard {
    projects.require(projectId);
    if (!input.title?.trim()) throw new HttpError(400, 'A card needs a title');
    const column = input.column && COLUMNS.includes(input.column) ? input.column : 'backlog';
    const priority = input.priority && PRIORITIES.includes(input.priority) ? input.priority : 'medium';
    const agent = input.agent?.trim() || 'claude';
    if (agent !== 'claude') agentClis.require(agent);
    const isolation = input.isolation ?? extSettings.get('workbench', { defaultIsolation: 'worktree' as Isolation }).defaultIsolation;
    const max = db.prepare('SELECT MAX(position) AS m FROM board_cards WHERE project_id = ? AND col = ?').get(projectId, column) as { m: number | null };
    const id = newId();
    const t = now();
    db.prepare(
      `INSERT INTO board_cards (id, project_id, title, description, col, position, priority, labels, agent, isolation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      input.title.trim().slice(0, 200),
      (input.description ?? '').slice(0, 20_000),
      column,
      (max.m ?? -1) + 1,
      priority,
      JSON.stringify((input.labels ?? []).map((l) => l.trim()).filter(Boolean).slice(0, 12)),
      agent,
      isolation === 'shared' ? 'shared' : 'worktree',
      t,
      t,
    );
    broadcast(projectId);
    return this.get(id);
  },

  update(
    id: string,
    patch: Partial<Pick<BoardCard, 'title' | 'description' | 'priority' | 'labels' | 'agent' | 'isolation' | 'column' | 'runStatus' | 'sessionId' | 'terminalId' | 'worktreeId'>>,
    silent = false,
  ): BoardCard {
    const card = this.get(id);
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.title !== undefined) put('title', patch.title.trim().slice(0, 200) || card.title);
    if (patch.description !== undefined) put('description', patch.description.slice(0, 20_000));
    if (patch.priority !== undefined && PRIORITIES.includes(patch.priority)) put('priority', patch.priority);
    if (patch.labels !== undefined) put('labels', JSON.stringify(patch.labels.map((l) => l.trim()).filter(Boolean).slice(0, 12)));
    if (patch.agent !== undefined) {
      if (patch.agent !== 'claude') agentClis.require(patch.agent);
      put('agent', patch.agent);
    }
    if (patch.isolation !== undefined) put('isolation', patch.isolation === 'shared' ? 'shared' : 'worktree');
    if (patch.runStatus !== undefined) put('run_status', patch.runStatus);
    if (patch.sessionId !== undefined) put('session_id', patch.sessionId);
    if (patch.terminalId !== undefined) put('terminal_id', patch.terminalId);
    if (patch.worktreeId !== undefined) put('worktree_id', patch.worktreeId);
    if (patch.column !== undefined && COLUMNS.includes(patch.column) && patch.column !== card.column) {
      const max = db.prepare('SELECT MAX(position) AS m FROM board_cards WHERE project_id = ? AND col = ?').get(card.projectId, patch.column) as {
        m: number | null;
      };
      put('col', patch.column);
      put('position', (max.m ?? -1) + 1);
    }
    if (!sets.length) return card;
    put('updated_at', now());
    db.prepare(`UPDATE board_cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    if (!silent) broadcast(card.projectId);
    return this.get(id);
  },

  /** Drop a card into `column` at `index`, renumbering that column. */
  move(id: string, column: BoardColumn, index: number): BoardCard {
    if (!COLUMNS.includes(column)) throw new HttpError(400, 'Unknown column');
    const card = this.get(id);
    tx(() => {
      const ids = (
        db.prepare('SELECT id FROM board_cards WHERE project_id = ? AND col = ? AND id != ? ORDER BY position, created_at').all(card.projectId, column, id) as {
          id: string;
        }[]
      ).map((r) => r.id);
      ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id);
      const stmt = db.prepare('UPDATE board_cards SET col = ?, position = ? WHERE id = ?');
      ids.forEach((cid, i) => stmt.run(column, i, cid));
      db.prepare('UPDATE board_cards SET updated_at = ? WHERE id = ?').run(now(), id);
    });
    broadcast(card.projectId);
    return this.get(id);
  },

  remove(id: string) {
    const card = this.get(id);
    db.prepare('DELETE FROM board_cards WHERE id = ?').run(id);
    broadcast(card.projectId);
  },

  /** Start (or resume) the agent for a card. */
  async start(id: string, opts: { model?: string; permissionMode?: Session['permissionMode'] } = {}): Promise<BoardCard> {
    const card = this.get(id);
    const isolated = card.isolation === 'worktree';

    if (card.agent === 'claude') {
      // Re-running a card continues its existing conversation (and worktree).
      if (card.sessionId) {
        try {
          const s = sessions.get(card.sessionId);
          if (s.row.archived) s.save({ archived: 0 });
          s.send('Continue with this board task. Pick up where you left off, then commit and summarise.');
          return this.update(id, { runStatus: 'running', column: card.column === 'done' ? 'done' : 'in_progress' });
        } catch {
          /* session was deleted: start fresh below */
        }
      }
      const session = await sessions.create(card.projectId, {
        title: card.title,
        isolation: card.isolation,
        branch: card.title,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      });
      session.send(promptFor(card, isolated));
      return this.update(id, { sessionId: session.id, worktreeId: session.worktree?.id ?? null, terminalId: null, runStatus: 'running', column: 'in_progress' });
    }

    // Another agent CLI: run it headless in a terminal (visible in the Terminal panel), in its own worktree.
    const cli = agentClis.require(card.agent);
    let wt = card.worktreeId ? worktrees.get(card.projectId, card.worktreeId) : null;
    if (isolated && !wt) wt = await worktrees.create(card.projectId, { name: card.title, ownerType: 'card', ownerId: card.id });
    const command = agentClis.headlessCommand(cli.id, promptFor(card, isolated));
    const term = terminals.create(card.projectId, {
      cwd: wt?.relPath ?? '.',
      command,
      title: `${cli.name.split(' ')[0]}: ${card.title}`.slice(0, 60),
      env: { CLOUDE_CARD_ID: card.id },
    });
    return this.update(id, { terminalId: term.id, worktreeId: wt?.id ?? null, sessionId: null, runStatus: 'running', column: 'in_progress' });
  },

  async stop(id: string): Promise<BoardCard> {
    const card = this.get(id);
    if (card.sessionId) await sessions.get(card.sessionId).interrupt().catch(() => {});
    if (card.terminalId) {
      try {
        terminals.kill(card.terminalId);
      } catch {
        /* already gone */
      }
    }
    return this.update(id, { runStatus: 'stopped' });
  },

  /** Called after a worktree branch lands on its base. */
  markMerged(projectId: string, worktreeId: string) {
    const rows = db.prepare('SELECT id FROM board_cards WHERE project_id = ? AND worktree_id = ?').all(projectId, worktreeId) as { id: string }[];
    for (const r of rows) this.update(r.id, { column: 'done', runStatus: 'succeeded' });
  },
};

// ---- follow the runs ------------------------------------------------------------

bus.on('session', (s) => {
  const rows = db.prepare('SELECT * FROM board_cards WHERE session_id = ?').all(s.id) as unknown as CardRow[];
  for (const r of rows) {
    const card = toCard(r);
    const patch = cardUpdateForSession(card, s);
    if (patch) board.update(card.id, { ...patch, worktreeId: s.worktree?.id ?? card.worktreeId });
  }
});

bus.on('session:deleted', (sessionId) => {
  const rows = db.prepare('SELECT id FROM board_cards WHERE session_id = ?').all(sessionId) as { id: string }[];
  for (const r of rows) board.update(r.id, { sessionId: null, runStatus: null });
});

bus.on('terminal:exit', ({ id, exitCode, signal }) => {
  const rows = db.prepare('SELECT * FROM board_cards WHERE terminal_id = ?').all(id) as unknown as CardRow[];
  for (const r of rows) {
    const card = toCard(r);
    if (card.runStatus === 'stopped') continue;
    // Killed (terminal closed, server shutdown) is not success, even though node-pty reports exitCode 0.
    if (signal) {
      board.update(card.id, { runStatus: 'stopped' });
      continue;
    }
    board.update(card.id, {
      runStatus: exitCode === 0 ? 'succeeded' : 'failed',
      ...(exitCode === 0 && card.column === 'in_progress' ? { column: 'review' as const } : {}),
    });
  }
});
