import { Brain, Globe, Menu, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Memory, MemoryType, Project } from '../../../shared/protocol';
import { Badge, Button, Dialog, Empty, Field, IconButton, Input, Select, Spinner, Textarea, Toggle } from '../components/ui';
import { api, ApiError, q } from '../lib/api';
import { timeAgo } from '../lib/format';
import { toast } from '../lib/store';

const TYPES: { id: MemoryType; label: string; hint: string }[] = [
  { id: 'project', label: 'Project', hint: 'Goals, constraints, decisions not visible in the code' },
  { id: 'feedback', label: 'Feedback', hint: 'How you want agents to work — corrections and confirmed approaches' },
  { id: 'user', label: 'User', hint: 'Who you are, your expertise and preferences' },
  { id: 'reference', label: 'Reference', hint: 'Pointers to external systems, dashboards, docs' },
];
const err = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

function MemoryEditor({ project, memory, open, onClose, onSaved }: { project: Project; memory: Memory | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<MemoryType>('project');
  const [global, setGlobal] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(memory?.name ?? '');
    setDescription(memory?.description ?? '');
    setContent(memory?.content ?? '');
    setType(memory?.type ?? 'project');
    setGlobal(memory ? memory.projectId === null : false);
  }, [open, memory]);

  async function save() {
    setBusy(true);
    try {
      if (memory) await api.patch(`/api/memory/${memory.id}`, { name, description, content, type });
      else await api.post('/api/memory', { projectId: global ? null : project.id, name, description, content, type });
      onSaved();
      onClose();
    } catch (e) {
      toast('error', 'Could not save the memory', err(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={memory ? 'Edit memory' : 'New memory'}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="Short key, e.g. deploy-target">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type" hint={TYPES.find((t) => t.id === type)?.hint}>
            <Select value={type} onChange={(e) => setType(e.target.value as MemoryType)} className="w-full">
              {TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="When is it relevant?" hint="One line. This is what every new session sees in its index.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Content">
          <Textarea rows={7} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        {!memory && (
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              Share with every project
              <span className="block text-xs text-ink-3">For facts about you rather than this codebase.</span>
            </span>
            <Toggle checked={global} onChange={setGlobal} label="Global" />
          </label>
        )}
        <div className="flex justify-end">
          <Button variant="primary" busy={busy} disabled={!name.trim() || !description.trim() || !content.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function MemoryView({ project, onOpenSessions }: { project: Project; onOpenSessions: () => void }) {
  const [list, setList] = useState<Memory[] | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ memory: Memory | null } | null>(null);

  const load = () =>
    api
      .get<{ memories: Memory[] }>(`/api/memory${q({ projectId: project.id, q: query.trim() || undefined })}`)
      .then((r) => setList(r.memories))
      .catch((e) => toast('error', 'Could not load memory', err(e)));

  useEffect(() => {
    const t = setTimeout(load, query ? 200 : 0);
    return () => clearTimeout(t);
  }, [project.id, query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <IconButton label="Sessions" className="lg:hidden" onClick={onOpenSessions}>
          <Menu className="size-[18px]" />
        </IconButton>
        <h1 className="font-display text-lg font-semibold">Memory</h1>
        <div className="ml-auto w-44">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="h-8 text-[13px]" />
        </div>
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ memory: null })}>
          Add
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <p className="mx-auto mb-3 max-w-3xl text-sm text-ink-2">
          Agents save what they learn here and every new session starts with the index (names and one-line descriptions), fetching details only when relevant — a few
          hundred tokens instead of re-explaining your project each time.
        </p>
        {!list ? (
          <div className="grid place-items-center py-10 text-ink-3">
            <Spinner className="size-5" />
          </div>
        ) : list.length === 0 ? (
          <Empty icon={<Brain className="size-8" />} title={query ? 'No matches' : 'Nothing remembered yet'}>
            Claude saves preferences, decisions and conventions as it works. You can add your own too.
          </Empty>
        ) : (
          <ul className="mx-auto max-w-3xl space-y-2">
            {list.map((m) => (
              <li key={m.id} className="group rounded-xl border border-line bg-surface p-3 shadow-cloud">
                <div className="flex items-start gap-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setEditing({ memory: m })}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[13px] font-semibold">{m.name}</span>
                      <Badge>{m.type}</Badge>
                      {!m.projectId && (
                        <Badge tone="sky">
                          <Globe className="size-3" /> global
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block text-sm text-ink-2">{m.description}</span>
                    <span className="mt-1 line-clamp-3 block text-[13px] whitespace-pre-wrap text-ink-3">{m.content}</span>
                  </button>
                  <span className="text-[11px] text-ink-3">{timeAgo(m.updatedAt)}</span>
                  <IconButton
                    label="Delete memory"
                    className="size-7 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    onClick={() =>
                      confirm(`Delete memory "${m.name}"?`) &&
                      api
                        .del(`/api/memory/${m.id}`)
                        .then(load)
                        .catch((e) => toast('error', err(e)))
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <MemoryEditor project={project} memory={editing?.memory ?? null} open={!!editing} onClose={() => setEditing(null)} onSaved={load} />
    </div>
  );
}
