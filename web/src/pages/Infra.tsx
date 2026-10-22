import clsx from 'clsx';
import { ArrowLeft, BrainCircuit, Boxes, HardDrive, Waypoints } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { Wordmark } from '../components/ui';
import { EmbeddingsTab } from '../infra/EmbeddingsTab';
import { RoutingTab } from '../infra/RoutingTab';
import { SandboxesTab } from '../infra/SandboxesTab';
import { StorageTab } from '../infra/StorageTab';

const TABS = [
  { id: 'routing', label: 'Model routing', icon: Waypoints },
  { id: 'sandboxes', label: 'Sandboxes', icon: Boxes },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'embeddings', label: 'Embeddings', icon: BrainCircuit },
] as const;
type Tab = (typeof TABS)[number]['id'];

/**
 * Control center: which model/provider handles which kind of task, the sandboxes
 * Claude runs, the storage cleaner, and embeddings. The page carries its own
 * header so it doesn't depend on the app shell (which other branches restyle).
 */
export function InfraPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'routing';
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-ground/80 px-4 backdrop-blur sm:px-6">
        <Link to="/" className="inline-flex size-9 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2" aria-label="Back to projects" title="Back to projects">
          <ArrowLeft className="size-[18px]" />
        </Link>
        <Link to="/" className="mr-auto">
          <Wordmark className="text-lg" />
        </Link>
        <Link to="/settings" className="text-sm text-ink-2 hover:text-ink">
          Settings
        </Link>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-7 pb-16 sm:px-6">
        <h1 className="font-display text-[30px] leading-tight font-semibold tracking-[-0.015em]">Control center</h1>
        <p className="mt-1 text-ink-2">Models and providers per task, sandboxes, storage and embeddings — everything the agents run on.</p>
        <nav className="mt-5 mb-5 flex gap-1 overflow-x-auto border-b border-line" aria-label="Control center sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setParams({ tab: t.id }, { replace: true })}
              aria-current={tab === t.id ? 'page' : undefined}
              className={clsx(
                '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                tab === t.id ? 'border-dawn text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
              )}
            >
              <t.icon className="size-4" />
              {t.label}
            </button>
          ))}
        </nav>
        {tab === 'routing' && <RoutingTab />}
        {tab === 'sandboxes' && <SandboxesTab />}
        {tab === 'storage' && <StorageTab />}
        {tab === 'embeddings' && <EmbeddingsTab />}
      </main>
    </div>
  );
}
