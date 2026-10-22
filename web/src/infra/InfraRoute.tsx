import { Suspense, lazy } from 'react';
import { Spinner } from '../components/ui';

// The control center is loaded on first visit so it never weighs on the main bundle.
const InfraPage = lazy(() => import('../pages/Infra').then((m) => ({ default: m.InfraPage })));

export function InfraRoute() {
  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center text-ink-3">
          <Spinner className="size-6" />
        </div>
      }
    >
      <InfraPage />
    </Suspense>
  );
}
