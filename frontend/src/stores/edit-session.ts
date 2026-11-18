import * as React from 'react';
import { create } from 'zustand';

/**
 * P47-T03 (ADR 0059 C2, freshness): which editors are open right now. An
 * editor (a form, a dialog, an inline cell) registers while it is editing;
 * an editable surface's queries pause their focus refetch and 60 s poll
 * while any editor is registered, so a refetch never replaces what a user
 * is typing. Not persisted; nothing else reads it.
 */
interface EditSessionState {
  editors: ReadonlySet<string>;
  add: (id: string) => void;
  remove: (id: string) => void;
}

export const useEditSessionStore = create<EditSessionState>()((set) => ({
  editors: new Set<string>(),
  add: (id) =>
    set((st) => (st.editors.has(id) ? st : { editors: new Set([...st.editors, id]) })),
  remove: (id) =>
    set((st) => {
      if (!st.editors.has(id)) return st;
      const next = new Set(st.editors);
      next.delete(id);
      return { editors: next };
    }),
}));

/** Registers the calling component as an open editor while `active`. */
export function useEditSession(active: boolean): void {
  const id = React.useId();
  const add = useEditSessionStore((st) => st.add);
  const remove = useEditSessionStore((st) => st.remove);
  React.useEffect(() => {
    if (!active) return undefined;
    add(id);
    return () => remove(id);
  }, [active, add, remove, id]);
}

/** Some editor is open anywhere on the page. */
export function useAnyEditInProgress(): boolean {
  return useEditSessionStore((st) => st.editors.size > 0);
}
