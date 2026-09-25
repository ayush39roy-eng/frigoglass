import { afterEach, describe, expect, it } from 'vitest';

import { useUiStore } from './ui';

afterEach(() => {
  useUiStore.setState({ sidebarCollapsed: false });
});

describe('useUiStore', () => {
  it('defaults to an expanded sidebar', () => {
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggles the sidebar', () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('sets the sidebar collapse state explicitly', () => {
    useUiStore.getState().setSidebarCollapsed(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });
});
