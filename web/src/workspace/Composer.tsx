import clsx from 'clsx';
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageAttachment, Session } from '../../../shared/protocol';
import { IconButton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { fileToBase64 } from '../lib/format';
import { toast, useStore } from '../lib/store';

interface Command {
  name: string;
  description: string;
  argumentHint?: string;
}

const commandCache: Record<string, Command[]> = {};
const drafts: Record<string, string> = {}; // unsent text survives switching sessions
const isTouch = typeof window !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function Composer({ session }: { session: Session }) {
  const [text, setText] = useState(drafts[session.id] ?? '');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [commands, setCommands] = useState<Command[]>(commandCache[session.id] ?? []);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const suggestion = useStore((s) => s.suggestions[session.id]);
  const busy = session.status === 'running' || session.status === 'starting' || session.status === 'awaiting_input';

  useEffect(() => {
    setText(drafts[session.id] ?? '');
    setImages([]);
  }, [session.id]);

  useEffect(() => {
    drafts[session.id] = text;
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
    }
  }, [text, session.id]);

  async function loadCommands() {
    if (commandCache[session.id]?.length) return;
    try {
      const { commands } = await api.get<{ commands: Command[] }>(`/api/sessions/${session.id}/commands`);
      commandCache[session.id] = commands;
      setCommands(commands);
    } catch {
      /* commands are a convenience */
    }
  }

  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const matches = useMemo(() => {
    if (slashQuery === undefined) return [];
    const q = slashQuery.toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [commands, slashQuery]);

  useEffect(() => setCmdIndex(0), [slashQuery]);

  async function addFiles(files: FileList | File[]) {
    const list = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
    if (!list.length) return;
    const next: ImageAttachment[] = [];
    for (const f of list) {
      if (f.size > 8 * 1024 * 1024) {
        toast('warning', `${f.name} is larger than 8 MB`);
        continue;
      }
      next.push({ mediaType: f.type as ImageAttachment['mediaType'], data: await fileToBase64(f), name: f.name });
    }
    setImages((cur) => [...cur, ...next].slice(0, 10));
  }

  async function send(override?: string) {
    const body = (override ?? text).trim();
    if ((!body && !images.length) || sending) return;
    setSending(true);
    try {
      await api.post(`/api/sessions/${session.id}/messages`, { text: body, images });
      setText('');
      setImages([]);
      drafts[session.id] = '';
    } catch (e) {
      toast('error', 'Message not sent', e instanceof ApiError ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  async function interrupt() {
    await api.post(`/api/sessions/${session.id}/interrupt`).catch(() => {});
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (matches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCmdIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCmdIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        setText(`/${matches[cmdIndex]!.name} `);
        return;
      }
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      void interrupt();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!isTouch && !e.shiftKey))) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="relative">
      {suggestion && !text && !busy && (
        <button
          onClick={() => setText(suggestion)}
          className="mb-2 max-w-full truncate rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-ink-2 hover:border-line-strong hover:text-ink"
          title="Use this suggestion"
        >
          {suggestion}
        </button>
      )}

      {matches.length > 0 && (
        <ul className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface shadow-cloud" role="listbox">
          {matches.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === cmdIndex}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(`/${c.name} `);
                  ref.current?.focus();
                }}
                className={clsx('flex w-full items-baseline gap-2 px-3 py-2 text-left', i === cmdIndex && 'bg-surface-2')}
              >
                <span className="font-mono text-[13px]">/{c.name}</span>
                {c.argumentHint && <span className="font-mono text-[11.5px] text-ink-3">{c.argumentHint}</span>}
                <span className="ml-auto truncate pl-2 text-xs text-ink-3">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        className="rounded-2xl border border-line-strong bg-surface shadow-cloud focus-within:border-ink/60"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {images.map((img, i) => (
              <div key={i} className="relative shrink-0">
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name ?? 'attachment'} className="size-16 rounded-lg border border-line object-cover" />
                <button
                  aria-label="Remove image"
                  onClick={() => setImages((cur) => cur.filter((_, k) => k !== i))}
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-ink p-0.5 text-ground"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={loadCommands}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.some((f) => IMAGE_TYPES.includes(f.type))) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder={busy ? 'Add a follow-up — Claude reads it next' : 'Ask Claude to build, fix, test or deploy… ( / for commands)'}
          aria-label="Message Claude"
          className="block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] placeholder:text-ink-3 focus:outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          <IconButton label="Attach image" onClick={() => fileRef.current?.click()}>
            <ImagePlus className="size-[18px]" />
          </IconButton>
          <span className="ml-1 hidden text-xs text-ink-3 sm:inline">{busy ? 'Esc to interrupt' : isTouch ? '' : 'Enter to send · Shift+Enter for a new line'}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {busy && (
              <button
                onClick={interrupt}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3 text-sm text-ink-2 hover:text-ink"
                aria-label="Interrupt Claude"
              >
                <Square className="size-3.5 fill-current" /> Stop
              </button>
            )}
            <button
              onClick={() => send()}
              disabled={(!text.trim() && !images.length) || sending}
              aria-label="Send"
              className="inline-flex size-9 items-center justify-center rounded-full bg-dawn text-white transition-opacity disabled:opacity-35"
            >
              <ArrowUp className="size-[18px]" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
