import { afterEach, describe, expect, it, vi } from 'vitest';

import { saveBlob } from './download';

describe('saveBlob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('creates an object URL, clicks a hidden download anchor, and revokes the URL afterwards', () => {
    vi.useFakeTimers();
    const createSpy = vi.spyOn(window.URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    const revokeSpy = vi.spyOn(window.URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });

    saveBlob(blob, 'matrix-export.csv');

    expect(createSpy).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // Not yet revoked — the timeout hasn't fired.
    expect(revokeSpy).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url');
  });

  it('sets the anchor download attribute to the given filename and removes it from the DOM', () => {
    vi.useFakeTimers();
    vi.spyOn(window.URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    vi.spyOn(window.URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      // At click time, the anchor is attached with the expected filename.
      expect(this.download).toBe('gantt-export.xlsx');
      expect(document.body.contains(this)).toBe(true);
    });

    saveBlob(new Blob(['x']), 'gantt-export.xlsx');

    expect(document.querySelector('a[download="gantt-export.xlsx"]')).toBeNull();
  });
});
