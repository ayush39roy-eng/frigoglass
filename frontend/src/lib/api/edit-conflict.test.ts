import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './client';
import {
  captureBase,
  changedKeys,
  editConflicts,
  forgetBase,
  keepMineBase,
  pickBase,
  sendEditWithBase,
  snapshotBase,
  type EditConflict,
} from './edit-conflict';

function conflict(over: Partial<EditConflict> = {}): EditConflict {
  return {
    entity: 'project',
    id: 'p1',
    label: 'Alpha',
    field: 'status',
    your_value: 'On Hold',
    current_value: 'Cancelled',
    changed_by: 'Maria Kosta',
    changed_at: '2026-11-18T09:05:00Z',
    ...over,
  };
}

function err409(conflicts: EditConflict[], where: 'top' | 'detail' = 'top'): ApiError {
  const body =
    where === 'top'
      ? { code: 'EDIT_CONFLICT', detail: 'Someone else changed this while you were editing.', conflicts }
      : { code: 'EDIT_CONFLICT', detail: { detail: 'Someone else changed this.', conflicts } };
  return new ApiError(409, 'Conflict', 'Someone else changed this.', 'EDIT_CONFLICT', undefined, body);
}

describe('edit-conflict: reading a 409 (ADR 0059 C1)', () => {
  it('reads conflicts at the top level or inside an object detail', () => {
    expect(editConflicts(err409([conflict()]))).toEqual([conflict()]);
    expect(editConflicts(err409([conflict()], 'detail'))).toEqual([conflict()]);
  });

  it('is null for any other error, including other 409 codes', () => {
    expect(editConflicts(new ApiError(409, 'Conflict', 'x', 'LAST_SUPER_ADMIN'))).toBeNull();
    expect(editConflicts(new ApiError(422, 'Bad', 'x', 'EDIT_CONFLICT'))).toBeNull();
    expect(editConflicts(new Error('x'))).toBeNull();
  });
});

describe('edit-conflict: building base', () => {
  it('pickBase holds only the named fields, as read', () => {
    expect(pickBase({ status: 'A', name: 'N', hub_id: 'h' }, ['status', 'missing'])).toEqual({ status: 'A', missing: null });
  });

  it('changedKeys compares deeply and never lists base', () => {
    expect(changedKeys({ a: 1, list: ['x'], b: 2 }, { a: 1, list: ['x', 'y'], b: 3, base: {} })).toEqual(['list', 'b']);
  });

  it('a snapshot keeps the FIRST value of a field; a later refetch never moves it', () => {
    let snaps = captureBase({}, 'p1', { status: 'In Development', hub_id: undefined }, ['status', 'hub_id']);
    expect(snaps).toEqual({ p1: { status: 'In Development' } }); // an unknown value is not captured
    snaps = captureBase(snaps, 'p1', { status: 'On Hold', hub_id: 'hub-1' }, ['status', 'hub_id']);
    expect(snaps.p1).toEqual({ status: 'In Development', hub_id: 'hub-1' });
    expect(snapshotBase(snaps, 'p1', ['status', 'leader'], { leader: 'eng-1' })).toEqual({
      status: 'In Development',
      leader: 'eng-1',
    });
    expect(forgetBase(snaps, 'p1', ['status'])).toEqual({ p1: { hub_id: 'hub-1' } });
    expect(forgetBase(snaps, 'p1')).toEqual({});
  });

  it('"Keep mine" takes the stored value; a hidden financial value leaves base', () => {
    const base = { status: 'In Development', tcogs_eur: 100, name: 'A' };
    expect(
      keepMineBase(base, [conflict(), conflict({ field: 'tcogs_eur', your_value: '<hidden>', current_value: '<hidden>' })]),
    ).toEqual({ status: 'Cancelled', name: 'A' });
  });
});

describe('sendEditWithBase (single-record PATCH loop, ADR 0059 C2)', () => {
  const original = { status: 'In Development', name: 'Alpha', external_code: null };

  it('sends only the changed fields with their base', async () => {
    const send = vi.fn().mockResolvedValue('ok');
    const out = await sendEditWithBase({ body: { status: 'On Hold' }, original, send, ask: vi.fn() });
    expect(out).toEqual({ outcome: 'saved', data: 'ok', dropped: [] });
    expect(send).toHaveBeenCalledWith({ status: 'On Hold', base: { status: 'In Development' } });
  });

  it('"Keep mine" resends with base = the stored value', async () => {
    const send = vi.fn().mockRejectedValueOnce(err409([conflict()])).mockResolvedValueOnce('ok');
    const ask = vi.fn().mockResolvedValue('mine');
    const out = await sendEditWithBase({ body: { status: 'On Hold', name: 'B' }, original, send, ask });
    expect(out.outcome).toBe('saved');
    expect(ask).toHaveBeenCalledWith([conflict()]);
    expect(send).toHaveBeenLastCalledWith({ status: 'On Hold', name: 'B', base: { status: 'Cancelled', name: 'Alpha' } });
  });

  it('"Use theirs" drops my value for the conflicting field, refetches and saves the rest', async () => {
    const send = vi.fn().mockRejectedValueOnce(err409([conflict()])).mockResolvedValueOnce('ok');
    const onUseTheirs = vi.fn();
    const out = await sendEditWithBase({
      body: { status: 'On Hold', name: 'B' },
      original,
      send,
      ask: vi.fn().mockResolvedValue('theirs'),
      onUseTheirs,
    });
    expect(onUseTheirs).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ outcome: 'saved', data: 'ok', dropped: ['status'] });
    expect(send).toHaveBeenLastCalledWith({ name: 'B', base: { name: 'Alpha' } });
  });

  it('"Use theirs" on the only changed field sends nothing more', async () => {
    const send = vi.fn().mockRejectedValueOnce(err409([conflict()]));
    const out = await sendEditWithBase({ body: { status: 'On Hold' }, original, send, ask: vi.fn().mockResolvedValue('theirs') });
    expect(out).toEqual({ outcome: 'theirs', dropped: ['status'] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a full-record PUT replaces my value with theirs instead of leaving the field out', async () => {
    const cal = { weekdays_per_week: 5, annual_leave_days: 25 };
    const send = vi
      .fn()
      .mockRejectedValueOnce(err409([conflict({ field: 'annual_leave_days', current_value: 22 })]))
      .mockResolvedValueOnce('ok');
    const out = await sendEditWithBase({
      body: { weekdays_per_week: 4, annual_leave_days: 20 },
      original: cal,
      send,
      ask: vi.fn().mockResolvedValue('theirs'),
      replaceOnTheirs: true,
    });
    expect(out.outcome).toBe('saved');
    expect(send).toHaveBeenLastCalledWith({
      weekdays_per_week: 4,
      annual_leave_days: 22,
      base: { weekdays_per_week: 5, annual_leave_days: 22 },
    });
  });

  it('a closed dialog saves nothing; any other error is rethrown', async () => {
    const send = vi.fn().mockRejectedValueOnce(err409([conflict()]));
    const out = await sendEditWithBase({ body: { status: 'On Hold' }, original, send, ask: vi.fn().mockResolvedValue(null) });
    expect(out.outcome).toBe('dismissed');
    const boom = new ApiError(422, 'Bad', 'x', 'NULL_NOT_ALLOWED');
    await expect(
      sendEditWithBase({ body: { status: 'On Hold' }, original, send: vi.fn().mockRejectedValue(boom), ask: vi.fn() }),
    ).rejects.toBe(boom);
  });
});

describe('dotted conflict fields (backend P47-T02 shapes)', () => {
  it('"Keep mine" sets a key of an object base, or a stage field', () => {
    expect(
      keepMineBase({ step_exclusions: { 'PDD-C': false, 'PDD-F': false } }, [
        conflict({ field: 'step_exclusions.PDD-C', current_value: true }),
      ]),
    ).toEqual({ step_exclusions: { 'PDD-C': true, 'PDD-F': false } });
    expect(
      keepMineBase({ status: 'In Progress', percent_complete: 40 }, [
        conflict({ entity: 'project_step', field: 'PDD-B.percent_complete', current_value: 60 }),
      ]),
    ).toEqual({ status: 'In Progress', percent_complete: 60 });
  });
});
