import clsx from 'clsx';
import { BrainCircuit, Boxes, HardDrive, Waypoints } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '../components/hud';
import { Page, Shell } from '../components/Shell';
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
 * Claude runs, the storage cleaner, and embeddings.
 */
export function InfraPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'routing';
  return (
    <Shell>
      <Page wide>
        <PageHeader title="Control center" subtitle="Models and providers per task, sandboxes, storage and embeddings — everything the agents run on." />
        <nav className="flex gap-1 overflow-x-auto border-b border-line" aria-label="Control center sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setParams({ tab: t.id }, { replace: true })}
              aria-current={tab === t.id ? 'page' : undefined}
              className={clsx(
                '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                tab === t.id ? 'border-sky text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
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
      </Page>
    </Shell>
  );
}
