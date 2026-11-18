import { create } from 'zustand';

import type { ConflictChoice, EditConflict } from '@/lib/api/edit-conflict';

/**
 * P47-T03 (ADR 0059 C2): the app-wide conflict dialog, for writes made from a
 * shared hook rather than a surface (the VIP pin, the VIP item writes). The
 * app shell mounts `EditConflictHost` once; `askEditConflict` opens it and
 * resolves with the user's choice. With no host mounted it resolves `null`
 * at once (nothing saved, no dialog), so a hook never waits forever.
 */
interface Pending {
  conflicts: EditConflict[];
  note: string | undefined;
  resolve: (choice: ConflictChoice) => void;
}

interface EditConflictHostState {
  hosts: number;
  pending: Pending | null;
  mount: () => () => void;
  finish: (choice: ConflictChoice) => void;
}

export const useEditConflictHostStore = create<EditConflictHostState>()((set, get) => ({
  hosts: 0,
  pending: null,
  mount: () => {
    set((st) => ({ hosts: st.hosts + 1 }));
    return () => set((st) => ({ hosts: Math.max(0, st.hosts - 1) }));
  },
  finish: (choice) => {
    get().pending?.resolve(choice);
    set({ pending: null });
  },
}));

export function askEditConflict(conflicts: EditConflict[], note?: string): Promise<ConflictChoice> {
  const store = useEditConflictHostStore;
  if (store.getState().hosts === 0) return Promise.resolve(null);
  return new Promise<ConflictChoice>((resolve) => {
    store.getState().pending?.resolve(null);
    store.setState({ pending: { conflicts, note, resolve } });
  });
}
