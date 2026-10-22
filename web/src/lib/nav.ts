import { Activity, CircleDollarSign, Gauge, Settings, ShieldCheck, type LucideIcon } from 'lucide-react';
import { api } from './api';
import { resetStore } from './store';
import { socket } from './ws';

export const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Ops', icon: Gauge },
  { to: '/usage', label: 'Usage', icon: CircleDollarSign },
  { to: '/monitor', label: 'Monitor', icon: Activity },
  { to: '/security', label: 'Security', icon: ShieldCheck },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export async function signOut(navigate: (to: string) => void) {
  await api.post('/api/auth/logout').catch(() => {});
  socket.stop();
  resetStore();
  navigate('/login');
}
