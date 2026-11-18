/**
 * ADR 0060 (P49): the two full-page navigations the app does on its own — a
 * sign-in that loads the newest bundle, and a reload onto a new version. One
 * object, so tests can spy on it (jsdom does not implement navigation).
 */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
  reload(): void {
    window.location.reload();
  },
};
