import { afterEach, describe, expect, it } from 'vitest';

import {
  DASHBOARD_VIEW_STORAGE_KEY,
  defaultViewForRoles,
  isDashboardView,
  readStoredDashboardView,
  resolveDashboardView,
  storeDashboardView,
} from './view-mode';

/** P28 (ADR 0039 §2): URL param → stored choice → role default. */
describe('resolveDashboardView', () => {
  it('a valid URL param wins over everything', () => {
    expect(resolveDashboardView('executive', 'detailed', ['Portfolio Manager'])).toBe('executive');
    expect(resolveDashboardView('detailed', 'executive', ['Executive Viewer'])).toBe('detailed');
  });

  it('a stored choice wins over the role default', () => {
    expect(resolveDashboardView(null, 'executive', ['Portfolio Manager'])).toBe('executive');
    expect(resolveDashboardView(null, 'detailed', ['Executive Viewer'])).toBe('detailed');
  });

  it('invalid URL and stored values fall through (never crash, never honoured)', () => {
    expect(resolveDashboardView('EXECUTIVE', 'board', ['Portfolio Manager'])).toBe('detailed');
    expect(resolveDashboardView('', null, ['Executive Viewer'])).toBe('executive');
    expect(resolveDashboardView(null, '{"x":1}', [])).toBe('detailed');
  });

  it('role default: Executive view ONLY for roles exactly ["Executive Viewer"]', () => {
    expect(defaultViewForRoles(['Executive Viewer'])).toBe('executive');
    // Any additional role keeps the Detailed default (ADR 0039 §2).
    expect(defaultViewForRoles(['Executive Viewer', 'Auditor'])).toBe('detailed');
    expect(defaultViewForRoles(['Auditor', 'Executive Viewer'])).toBe('detailed');
    expect(defaultViewForRoles(['Super Admin'])).toBe('detailed');
    expect(defaultViewForRoles([])).toBe('detailed');
  });

  it('isDashboardView accepts exactly the two wire values', () => {
    expect(isDashboardView('executive')).toBe(true);
    expect(isDashboardView('detailed')).toBe(true);
    expect(isDashboardView('Executive')).toBe(false);
    expect(isDashboardView(null)).toBe(false);
  });
});

describe('view persistence', () => {
  afterEach(() => {
    window.localStorage.removeItem(DASHBOARD_VIEW_STORAGE_KEY);
  });

  it('stores under rpd-dashboard-view and reads it back', () => {
    storeDashboardView('executive');
    expect(window.localStorage.getItem(DASHBOARD_VIEW_STORAGE_KEY)).toBe('executive');
    expect(readStoredDashboardView()).toBe('executive');
  });

  it('returns null when nothing is stored', () => {
    expect(readStoredDashboardView()).toBeNull();
  });
});
