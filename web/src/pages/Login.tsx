import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { bootstrap } from '../App';
import { Button, Input, Wordmark } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useStore } from '../lib/store';

export function Login() {
  const user = useStore((s) => s.user);
  const [params] = useSearchParams();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next') || '/';

  if (user) {
    // /api/* "next" targets (preview hand-off) are server routes, not SPA routes.
    if (next.startsWith('/api/')) window.location.href = next;
    else return <Navigate to={next} replace />;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: { id: string; username: string } }>('/api/auth/login', { username, password });
      if (next.startsWith('/api/')) {
        window.location.href = next;
        return;
      }
      useStore.setState({ user });
      await bootstrap();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <Wordmark className="mb-8 text-2xl" />
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.015em]">Sign in to your workbench</h1>
        <p className="mt-2 text-ink-2">Claude is waiting on your server. Your sessions keep running while you're away.</p>
        <form onSubmit={submit} className="mt-8 space-y-3">
          <Input aria-label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" />
          <Input
            aria-label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
          />
          {error && <p className="text-sm text-bad">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            Sign in
          </Button>
        </form>
        <p className="mt-6 text-xs text-ink-3">
          First run? The admin password is in the server log, or in <code className="font-mono">initial-admin-password.txt</code> in Cloude's data
          directory.
        </p>
      </div>
      <div className="drift mt-16 w-full max-w-sm rounded-full" data-state="running" aria-hidden />
    </div>
  );
}
