import clsx from 'clsx';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { PermissionRequest, PermissionResponse } from '../../../shared/protocol';
import { Button, Input, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/store';
import { StringDiff } from './DiffView';
import { Markdown } from './Markdown';

async function respond(req: PermissionRequest, body: PermissionResponse) {
  try {
    await api.post(`/api/sessions/${req.sessionId}/permissions/${req.id}`, body as any);
  } catch (e) {
    toast('error', 'Could not send your answer', e instanceof ApiError ? e.message : String(e));
  }
}

function ToolPreview({ req, root }: { req: PermissionRequest; root?: string }) {
  const i = req.input as Record<string, any>;
  const rel = (p: string) => (root && p?.startsWith(root + '/') ? p.slice(root.length + 1) : p);
  if (req.toolName === 'Bash')
    return (
      <div className="porthole overflow-x-auto px-3 py-2">
        <span className="text-dawn select-none">$ </span>
        <span className="whitespace-pre-wrap">{i.command}</span>
      </div>
    );
  if (req.toolName === 'Edit')
    return (
      <div className="space-y-1.5">
        <p className="font-mono text-xs text-ink-2">{rel(i.file_path)}</p>
        <StringDiff before={String(i.old_string ?? '')} after={String(i.new_string ?? '')} maxLines={120} />
      </div>
    );
  if (req.toolName === 'Write')
    return (
      <div className="space-y-1.5">
        <p className="font-mono text-xs text-ink-2">{rel(i.file_path)}</p>
        <pre className="porthole max-h-56 overflow-auto px-3 py-2 whitespace-pre-wrap">{String(i.content ?? '').slice(0, 6000)}</pre>
      </div>
    );
  return <pre className="porthole max-h-56 overflow-auto px-3 py-2 whitespace-pre-wrap">{JSON.stringify(i, null, 2)}</pre>;
}

function ToolRequest({ req, root }: { req: PermissionRequest; root?: string }) {
  const [note, setNote] = useState('');
  const [denying, setDenying] = useState(false);
  const outward = /mcp__cloude__(publish|deploy|open_tunnel)/.test(req.toolName);
  return (
    <>
      <p className="text-sm font-semibold">{req.title ?? `Claude wants to use ${req.toolName}`}</p>
      {req.description && <p className="mt-0.5 text-[13px] text-ink-2">{req.description}</p>}
      {outward && <p className="mt-1 text-[13px] text-break-ink">This makes something reachable from the internet.</p>}
      <div className="mt-2.5">
        <ToolPreview req={req} root={root} />
      </div>
      {denying ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void respond(req, { decision: 'deny', message: note });
          }}
        >
          <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell Claude what to do instead (optional)" />
          <Button type="submit" variant="danger">
            Decline
          </Button>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => respond(req, { decision: 'allow' })}>
            Allow
          </Button>
          {req.canRemember && (
            <Button onClick={() => respond(req, { decision: 'allow', remember: true })} title="Don't ask again for this kind of action in this session">
              Allow for this session
            </Button>
          )}
          <Button variant="ghost" onClick={() => setDenying(true)}>
            Decline…
          </Button>
        </div>
      )}
    </>
  );
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
}

function QuestionRequest({ req }: { req: PermissionRequest }) {
  const questions = ((req.input as any).questions ?? []) as Question[];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const complete = questions.every((q) => (picked[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());

  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      if (!q.multiSelect) return { ...p, [q.question]: [label] };
      return { ...p, [q.question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });

  return (
    <>
      <p className="text-sm font-semibold">Claude has {questions.length === 1 ? 'a question' : `${questions.length} questions`}</p>
      <div className="mt-3 space-y-4">
        {questions.map((q) => (
          <fieldset key={q.question}>
            <legend className="text-sm font-medium">{q.question}</legend>
            <div className="mt-2 grid gap-1.5">
              {q.options.map((o) => {
                const on = picked[q.question]?.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => toggle(q, o.label)}
                    className={clsx(
                      'rounded-lg border px-3 py-2 text-left transition-colors',
                      on ? 'border-ink bg-surface-2' : 'border-line hover:border-line-strong',
                    )}
                    aria-pressed={on}
                  >
                    <span className="text-sm font-medium">{o.label}</span>
                    {o.description && <span className="block text-[13px] text-ink-2">{o.description}</span>}
                    {on && o.preview && <Markdown text={o.preview} className="mt-2 text-[13px]" />}
                  </button>
                );
              })}
              <Input
                value={other[q.question] ?? ''}
                onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))}
                placeholder="Other — type your own answer"
              />
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Button
          variant="primary"
          disabled={!complete}
          onClick={() => {
            const answers: Record<string, string> = {};
            for (const q of questions) {
              const parts = [...(picked[q.question] ?? [])];
              if (other[q.question]?.trim()) parts.push(other[q.question]!.trim());
              answers[q.question] = parts.join(', ');
            }
            void respond(req, { decision: 'allow', answers });
          }}
        >
          Send answers
        </Button>
        <Button variant="ghost" onClick={() => respond(req, { decision: 'deny', message: 'The user skipped these questions.' })}>
          Skip
        </Button>
      </div>
    </>
  );
}

function PlanRequest({ req }: { req: PermissionRequest }) {
  const [feedback, setFeedback] = useState('');
  return (
    <>
      <p className="text-sm font-semibold">Claude's plan is ready for review</p>
      <div className="mt-2.5 max-h-[45vh] overflow-y-auto rounded-lg border border-line bg-surface-2 p-3">
        <Markdown text={String((req.input as any).plan ?? '')} className="text-sm" />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => respond(req, { decision: 'allow', remember: true })}>
          Approve and auto-edit
        </Button>
        <Button onClick={() => respond(req, { decision: 'allow' })}>Approve, ask before edits</Button>
      </div>
      <div className="mt-2 flex gap-2">
        <Textarea rows={1} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Or tell Claude what to change…" />
        <Button variant="ghost" disabled={!feedback.trim()} onClick={() => respond(req, { decision: 'deny', message: feedback })}>
          Keep planning
        </Button>
      </div>
    </>
  );
}

function ElicitationRequest({ req }: { req: PermissionRequest }) {
  const i = req.input as any;
  const props: Record<string, any> = i.requestedSchema?.properties ?? {};
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <>
      <p className="text-sm font-semibold">{req.title ?? 'An MCP server needs input'}</p>
      <p className="mt-0.5 text-[13px] text-ink-2">
        From <span className="font-mono">{i.serverName}</span>
        {i.message && i.message !== req.title ? ` — ${i.message}` : ''}
      </p>
      {/* MCP servers are third-party: only ever render http(s) links (no javascript: URLs). */}
      {i.mode === 'url' && typeof i.url === 'string' && /^https?:\/\//i.test(i.url) && (
        <a href={i.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-sm text-sky underline">
          Open link <ExternalLink className="size-3.5" />
        </a>
      )}
      {Object.keys(props).length > 0 && (
        <div className="mt-3 space-y-2">
          {Object.entries(props).map(([k, schema]) => (
            <label key={k} className="block text-sm">
              <span className="text-ink-2">{schema.title ?? k}</span>
              <Input
                type={schema.format === 'password' ? 'password' : 'text'}
                value={values[k] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                placeholder={schema.description}
              />
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          onClick={() => {
            const content: Record<string, unknown> = {};
            for (const [k, schema] of Object.entries(props)) {
              const v = values[k];
              if (v === undefined || v === '') continue;
              content[k] = schema.type === 'number' || schema.type === 'integer' ? Number(v) : schema.type === 'boolean' ? v === 'true' : v;
            }
            void respond(req, { decision: 'allow', content });
          }}
        >
          {i.mode === 'url' ? "I've finished" : 'Submit'}
        </Button>
        <Button variant="ghost" onClick={() => respond(req, { decision: 'deny' })}>
          Decline
        </Button>
      </div>
    </>
  );
}

export function PermissionCard({ req, root }: { req: PermissionRequest; root?: string }) {
  return (
    <div className="rounded-xl border border-break bg-surface p-3.5 shadow-cloud" role="alert">
      {req.kind === 'question' ? (
        <QuestionRequest req={req} />
      ) : req.kind === 'plan' ? (
        <PlanRequest req={req} />
      ) : req.kind === 'elicitation' ? (
        <ElicitationRequest req={req} />
      ) : (
        <ToolRequest req={req} root={root} />
      )}
    </div>
  );
}
