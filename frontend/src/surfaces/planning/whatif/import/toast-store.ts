import { create } from 'zustand';

/** P41: the plan import's one success toast (rendered by `components/import-toast.tsx`). */
interface ToastState {
  message: string | null;
  nonce: number;
  show: (message: string) => void;
  dismiss: () => void;
}

export const useImportToast = create<ToastState>()((set) => ({
  message: null,
  nonce: 0,
  show: (message) => set((s) => ({ message, nonce: s.nonce + 1 })),
  dismiss: () => set({ message: null }),
}));
