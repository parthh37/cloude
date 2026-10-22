import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import type { AuthUser, Project, Route as PublishedRoute, ServiceState, Session, SystemStatus, Tunnel, UsageLive } from '../../shared/protocol';
import { Toaster } from './components/Toaster';
import { Spinner } from './components/ui';
import { api } from './lib/api';
import { resetStore, upsertSessions, useStore } from './lib/store';
import { socket } from './lib/ws';
import { InfraRoute } from './infra/InfraRoute';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { MonitorPage } from './pages/Monitor';
import { SecurityPage } from './pages/Security';
import { SettingsPage } from './pages/Settings';
import { UsagePage } from './pages/Usage';
import { Workspace } from './pages/Workspace';

/** Load everything the shell needs once signed in, and keep the socket open. */
export async function bootstrap() {
  const [p, s, svc, r, t, st, usage] = await Promise.all([
    api.get<{ projects: Project[] }>('/api/projects'),
    api.get<{ sessions: Session[] }>('/api/sessions'),
    api.get<{ services: ServiceState[] }>('/api/services'),
    api.get<{ routes: PublishedRoute[] }>('/api/routes'),
    api.get<{ tunnels: Tunnel[] }>('/api/tunnels'),
    api.get<SystemStatus>('/api/status'),
    api.get<UsageLive>('/api/usage/live'),
  ]);
  upsertSessions(s.sessions);
  useStore.setState({ projects: p.projects, services: svc.services, routes: r.routes, tunnels: t.tunnels, status: st, usage });
  socket.start();
}

function useAuth() {
  useEffect(() => {
    api
      .get<{ user: AuthUser | null }>('/api/auth/me')
      .then(async ({ user }) => {
        useStore.setState({ user, authChecked: true });
        if (user) await bootstrap();
      })
      .catch(() => useStore.setState({ user: null, authChecked: true }));
    const onUnauthorized = () => {
      socket.stop();
      resetStore();
    };
    window.addEventListener('cloude:unauthorized', onUnauthorized);
    return () => window.removeEventListener('cloude:unauthorized', onUnauthorized);
  }, []);
}

/** Title badge so a backgrounded tab shows when Claude needs you. */
function useTitleBadge() {
  const waiting = useStore((s) => Object.values(s.sessions).filter((x) => x.status === 'awaiting_input').length);
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Needs you · Cloude` : 'Cloude';
  }, [waiting]);
}

function Gate({ children }: { children: React.ReactNode }) {
  const { user, authChecked } = useStore();
  const loc = useLocation();
  if (!authChecked)
    return (
      <div className="hud-ground grid h-full place-items-center text-ink-3">
        <Spinner className="size-6" />
      </div>
    );
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

export function App() {
  useAuth();
  useTitleBadge();
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <Gate>
              <Dashboard />
            </Gate>
          }
        />
        <Route
          path="/usage"
          element={
            <Gate>
              <UsagePage />
            </Gate>
          }
        />
        <Route
          path="/monitor"
          element={
            <Gate>
              <MonitorPage />
            </Gate>
          }
        />
        <Route
          path="/security"
          element={
            <Gate>
              <SecurityPage />
            </Gate>
          }
        />
        <Route
          path="/settings"
          element={
            <Gate>
              <SettingsPage />
            </Gate>
          }
        />
        <Route
          path="/p/:projectId/*"
          element={
            <Gate>
              <Workspace />
            </Gate>
          }
        />
        <Route
          path="/infra"
          element={
            <Gate>
              <InfraRoute />
            </Gate>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </BrowserRouter>
  );
}
