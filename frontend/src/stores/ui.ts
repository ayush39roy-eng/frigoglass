import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * UI-chrome state only (sidebar collapse, etc.). One store per concern
 * (frontend-builder SKILL) — server state lives in TanStack Query, scenario-edit
 * deltas will live in `stores/scenario.ts` (P5). Nothing derived from domain data
 * belongs here.
 */
interface UiState {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    }),
    { name: 'rpd-ui' },
  ),
);
