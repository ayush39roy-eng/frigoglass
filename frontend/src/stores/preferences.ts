import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { MeResponse } from '@/lib/api/session';
import type { SurfaceKey } from '@/types/enums';

/**
 * Per-browser profile preferences (2026-10-01, Profile & settings page).
 *
 * Stored in this browser only (`localStorage`). Nothing here reaches the server.
 * The profile photo especially is personal data (GDPR, OPEN_QUESTIONS #8), so it
 * stays on the device that uploaded it, keyed by the signed-in email.
 */
export type StartPage = '/' | '/capacity' | '/matrix' | '/timeline' | '/register' | '/planning';

interface PreferencesState {
  avatars: Record<string, string>;
  reduceMotion: boolean;
  startPage: StartPage;
  setAvatar: (email: string, dataUrl: string | null) => void;
  setReduceMotion: (value: boolean) => void;
  setStartPage: (page: StartPage) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      avatars: {},
      reduceMotion: false,
      startPage: '/',
      setAvatar: (email, dataUrl) =>
        set((state) => {
          const avatars = { ...state.avatars };
          if (dataUrl === null) delete avatars[email];
          else avatars[email] = dataUrl;
          return { avatars };
        }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
      setStartPage: (startPage) => set({ startPage }),
    }),
    { name: 'rpd-preferences' },
  ),
);

export function useAvatarFor(email: string | undefined): string | null {
  return usePreferencesStore((s) => (email ? (s.avatars[email] ?? null) : null));
}

const START_PAGE_SURFACE: Record<StartPage, SurfaceKey> = {
  '/': 'dashboard',
  '/capacity': 'capacity',
  '/matrix': 'matrix',
  '/timeline': 'gantt',
  '/register': 'project_registration',
  '/planning': 'capacity_planning',
};

/** The preferred start page if this user may read it, else the Dashboard. */
export function resolveStartPage(me: MeResponse | null, preferred: StartPage): StartPage {
  const surface = START_PAGE_SURFACE[preferred];
  return me?.permissions[surface]?.read ? preferred : '/';
}
