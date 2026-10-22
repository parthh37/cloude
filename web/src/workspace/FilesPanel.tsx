import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import CodeMirror from '@uiw/react-codemirror';
import clsx from 'clsx';
import { ArrowLeft, ChevronRight, Download, Eye, EyeOff, File, FilePlus, Folder, FolderPlus, MoreHorizontal, Pencil, RefreshCw, Save, Search, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry, Project } from '../../../shared/protocol';
import { Button, IconButton, Input, Spinner } from '../components/ui';
import { api, ApiError, q } from '../lib/api';
import { bytes } from '../lib/format';
import { toast } from '../lib/store';

interface OpenFile {
  path: string;
  content: string | null;
  original: string | null;
  binary: boolean;
  size: number;
  mtime: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i;
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

function Tree({
  project,
  dir,
  depth,
  showHidden,
  version,
  openPath,
  onOpen,
  onChanged,
}: {
  project: Project;
  dir: string;
  depth: number;
  showHidden: boolean;
  version: number;
  openPath?: string;
  onOpen: (p: string) => void;
  onChanged: () => void;
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ entries: FileEntry[] }>(`/api/projects/${project.id}/files${q({ path: dir, hidden: showHidden })}`)
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]));
  }, [project.id, dir, showHidden, version]);

  if (!entries) return <div className="py-1 text-ink-3" style={{ paddingLeft: 12 + depth * 14 }}><Spinner className="size-3.5" /></div>;

  async function rename(e: FileEntry) {
    setMenu(null);
    const to = prompt('Rename to', e.path);
    if (!to || to === e.path) return;
    await api.post(`/api/projects/${project.id}/files/rename`, { from: e.path, to }).catch((err) => toast('error', err.message));
    onChanged();
  }
  async function remove(e: FileEntry) {
    setMenu(null);
    if (!confirm(`Delete ${e.path}?`)) return;
    await api.del(`/api/projects/${project.id}/file${q({ path: e.path })}`).catch((err) => toast('error', err.message));
    onChanged();
  }

  return (
    <ul>
      {entries.map((e) => {
        const isOpen = expanded.has(e.path);
        return (
          <li key={e.path}>
            <div
              className={clsx('group relative flex items-center rounded-md pr-1 hover:bg-surface-2', openPath === e.path && 'bg-surface-2 font-medium')}
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[13.5px]"
                onClick={() => {
                  if (e.type === 'dir')
                    setExpanded((s) => {
                      const n = new Set(s);
                      if (n.has(e.path)) n.delete(e.path);
                      else n.add(e.path);
                      return n;
                    });
                  else onOpen(e.path);
                }}
              >
                {e.type === 'dir' ? (
                  <>
                    <ChevronRight className={clsx('size-3.5 shrink-0 text-ink-3 transition-transform', isOpen && 'rotate-90')} />
                    <Folder className="size-4 shrink-0 text-sky" />
                  </>
                ) : (
                  <>
                    <span className="w-3.5 shrink-0" />
                    <File className="size-4 shrink-0 text-ink-3" />
                  </>
                )}
                <span className="truncate">{e.name}</span>
              </button>
              <button
                aria-label={`Actions for ${e.name}`}
                className="rounded p-0.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:text-ink focus:opacity-100 max-lg:opacity-60"
                onClick={() => setMenu(menu === e.path ? null : e.path)}
              >
                <MoreHorizontal className="size-4" />
              </button>
              {menu === e.path && (
                <div className="absolute top-full right-0 z-20 w-40 rounded-lg border border-line bg-surface p-1 shadow-cloud" onMouseLeave={() => setMenu(null)}>
                  <button onClick={() => rename(e)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2">
                    <Pencil className="size-3.5" /> Rename
                  </button>
                  {e.type !== 'dir' && (
                    <a
                      href={`/api/projects/${project.id}/raw${q({ path: e.path })}`}
                      download={e.name}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                    >
                      <Download className="size-3.5" /> Download
                    </a>
                  )}
                  <button onClick={() => remove(e)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-bad hover:bg-bad-soft">
                    <Trash2 className="size-3.5" /> Delete
                  </button>
                </div>
              )}
            </div>
            {e.type === 'dir' && isOpen && (
              <Tree
                project={project}
                dir={e.path}
                depth={depth + 1}
                showHidden={showHidden}
                version={version}
                openPath={openPath}
                onOpen={onOpen}
                onChanged={onChanged}
              />
            )}
          </li>
        );
      })}
      {entries.length === 0 && depth === 0 && <li className="px-3 py-4 text-sm text-ink-3">This project is empty. Ask Claude to scaffold something.</li>}
    </ul>
  );
}

function Editor({ project, file, onChange, onSave, saving }: { project: Project; file: OpenFile; onChange: (v: string) => void; onSave: () => void; saving: boolean }) {
  const [lang, setLang] = useState<Extension[]>([]);
  useEffect(() => {
    const desc = LanguageDescription.matchFilename(languages, file.path.split('/').pop() ?? '');
    if (!desc) return setLang([]);
    desc.load().then((s) => setLang([s])).catch(() => setLang([]));
  }, [file.path]);

  if (IMAGE_EXT.test(file.path))
    return (
      <div className="grid h-full place-items-center overflow-auto bg-surface-2 p-4">
        <img src={`/api/projects/${project.id}/raw${q({ path: file.path, v: file.mtime })}`} alt={file.path} className="max-h-full max-w-full" />
      </div>
    );
  if (file.binary || file.content === null)
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-ink-2">
        <div>
          <p>{file.size > 2 * 1024 * 1024 ? `This file is ${bytes(file.size)} — too large to edit in the browser.` : 'This is a binary file.'}</p>
          <a className="mt-2 inline-block text-sky underline" href={`/api/projects/${project.id}/raw${q({ path: file.path })}`} download>
            Download it
          </a>
        </div>
      </div>
    );
  return (
    <CodeMirror
      value={file.content}
      height="100%"
      className="h-full"
      theme={dark() ? githubDark : githubLight}
      extensions={[...lang, EditorView.lineWrapping]}
      onChange={onChange}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          if (!saving) onSave();
        }
      }}
      basicSetup={{ foldGutter: true, highlightActiveLine: true }}
    />
  );
}

export function FilesPanel({ project }: { project: Project }) {
  const [version, setVersion] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<string[] | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dirty = !!file && file.content !== file.original;
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  async function open(path: string) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    try {
      const r = await api.get<{ path: string; content: string | null; binary: boolean; size: number; mtime: number }>(
        `/api/projects/${project.id}/file${q({ path })}`,
      );
      setFile({ ...r, path, original: r.content });
      setResults(null);
      setSearch('');
    } catch (e) {
      toast('error', 'Could not open file', e instanceof ApiError ? e.message : String(e));
    }
  }

  async function save(force = false) {
    if (!file || file.content === null) return;
    setSaving(true);
    try {
      const r = await api.put<{ mtime: number }>(`/api/projects/${project.id}/file`, {
        path: file.path,
        content: file.content,
        ...(force ? {} : { expectedMtime: file.mtime }),
      });
      setFile({ ...file, original: file.content, mtime: r.mtime });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (confirm('This file changed on the server (maybe Claude edited it). Overwrite with your version?')) await save(true);
      } else toast('error', 'Save failed', e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function create(kind: 'file' | 'dir') {
    const name = prompt(kind === 'file' ? 'New file path (e.g. src/app.ts)' : 'New folder path');
    if (!name) return;
    try {
      if (kind === 'dir') await api.post(`/api/projects/${project.id}/files/mkdir`, { path: name });
      else await api.put(`/api/projects/${project.id}/file`, { path: name, content: '' });
      refresh();
      if (kind === 'file') await open(name);
    } catch (e) {
      toast('error', 'Could not create it', e instanceof ApiError ? e.message : String(e));
    }
  }

  async function upload(files: FileList) {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    try {
      const { saved } = await api.post<{ saved: string[] }>(`/api/projects/${project.id}/upload`, fd);
      toast('success', `Uploaded ${saved.length} file${saved.length === 1 ? '' : 's'}`);
      refresh();
    } catch (e) {
      toast('error', 'Upload failed', e instanceof ApiError ? e.message : String(e));
    }
  }

  useEffect(() => {
    if (!search.trim()) return setResults(null);
    const t = setTimeout(() => {
      api
        .get<{ paths: string[] }>(`/api/projects/${project.id}/files/search${q({ q: search })}`)
        .then((r) => setResults(r.paths))
        .catch(() => setResults([]));
    }, 180);
    return () => clearTimeout(t);
  }, [search, project.id]);

  const tree = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a file" className="h-8 pl-8 text-[13px]" />
        </div>
        <IconButton label="New file" onClick={() => create('file')}>
          <FilePlus className="size-4" />
        </IconButton>
        <IconButton label="New folder" onClick={() => create('dir')}>
          <FolderPlus className="size-4" />
        </IconButton>
        <IconButton label="Upload files" onClick={() => uploadRef.current?.click()}>
          <Upload className="size-4" />
        </IconButton>
        <IconButton label={showHidden ? 'Hide ignored folders' : 'Show ignored folders'} onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </IconButton>
        <IconButton label="Refresh" onClick={refresh}>
          <RefreshCw className="size-4" />
        </IconButton>
        <input ref={uploadRef} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {results ? (
          results.length ? (
            results.map((p) => (
              <button key={p} onClick={() => open(p)} className="block w-full truncate rounded-md px-2 py-1 text-left font-mono text-[12.5px] hover:bg-surface-2">
                {p}
              </button>
            ))
          ) : (
            <p className="px-2 py-3 text-sm text-ink-3">No matching files.</p>
          )
        ) : (
          <Tree project={project} dir="" depth={0} showHidden={showHidden} version={version} openPath={file?.path} onOpen={open} onChanged={refresh} />
        )}
      </div>
    </div>
  );

  const editor = file && (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <IconButton label="Back to files" className="lg:hidden" onClick={() => (dirty && !confirm('Discard unsaved changes?') ? null : setFile(null))}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={file.path}>
          {file.path}
          {dirty && <span className="ml-1 text-dawn">●</span>}
        </span>
        <IconButton label="Reload from disk" onClick={() => open(file.path)}>
          <RefreshCw className="size-4" />
        </IconButton>
        {file.content !== null && (
          <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} busy={saving} icon={<Save className="size-3.5" />} onClick={() => save()}>
            Save
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Editor project={project} file={file} saving={saving} onSave={() => save()} onChange={(v) => setFile((f) => (f ? { ...f, content: v } : f))} />
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0">
      <div className={clsx('min-h-0 border-line lg:w-60 lg:shrink-0 lg:border-r', file ? 'hidden lg:block' : 'w-full')}>{tree}</div>
      <div className={clsx('min-h-0 min-w-0 flex-1', !file && 'hidden lg:block')}>
        {editor ?? <div className="grid h-full place-items-center text-sm text-ink-3">Select a file to view or edit it.</div>}
      </div>
    </div>
  );
}
