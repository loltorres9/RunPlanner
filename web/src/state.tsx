/** Gemeinsamer Zustand der App und einfache Navigation über den URL-Hash. */

import { createContext, useContext, useEffect, useState } from 'react';
import type { Me, RunEvent } from '@runplanner/shared';

export interface AppState {
  me: Me;
  setMe: (me: Me) => void;
  groupId: string;
  setGroupId: (id: string) => void;
  events: RunEvent[];
  eventsLoaded: boolean;
  reloadEvents: () => Promise<void>;
  putEvent: (event: RunEvent) => void;
  dropEvent: (id: string) => void;
  importEnabled: boolean;
  logout: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (value === null) throw new Error('AppContext fehlt');
  return value;
}

/** Route aus dem Hash, z. B. "#/event/123/edit" → ["event", "123", "edit"]. */
export function useRoute(): string[] {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function navigate(path: string, replace = false): void {
  const target = `#/${path.replace(/^\//, '')}`;
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function storedGroupId(): string | null {
  try {
    return localStorage.getItem('groupId');
  } catch {
    return null;
  }
}

export function storeGroupId(id: string): void {
  try {
    localStorage.setItem('groupId', id);
  } catch {
    // egal
  }
}
