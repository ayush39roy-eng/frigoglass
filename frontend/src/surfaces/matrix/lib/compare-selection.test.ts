import { beforeEach, describe, expect, it } from 'vitest';

import { SIGNED_OUT_EVENT, clearAppSessionStorage } from '@/lib/auth/use-sign-out';

import { useCompareSelection } from './compare-selection';

const KEY = 'rpd-matrix-compare';

describe('compare selection and sign-out (S21-L2)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useCompareSelection.setState({ items: [], capHit: false });
  });

  it('persists the selection to sessionStorage while signed in', () => {
    useCompareSelection.getState().toggle({ id: 'a', name: 'Alpha', hub: 'R&D-Greece' });
    expect(sessionStorage.getItem(KEY)).toContain('Alpha');
  });

  it('clears the in-memory items on the signed-out event and does not repopulate sessionStorage', () => {
    const { toggle } = useCompareSelection.getState();
    toggle({ id: 'a', name: 'Alpha', hub: 'R&D-Greece' });
    toggle({ id: 'b', name: 'Beta', hub: 'PD-India' });
    expect(useCompareSelection.getState().items).toHaveLength(2);

    // What useSignOut does: clear the rpd- keys, then dispatch the event.
    clearAppSessionStorage();
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));

    expect(useCompareSelection.getState().items).toEqual([]);
    expect(useCompareSelection.getState().capHit).toBe(false);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('rpd-'))).toEqual([]);
  });
});
