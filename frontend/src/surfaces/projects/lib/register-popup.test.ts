import { describe, expect, it } from 'vitest';

import type { ProjectRead } from '@/surfaces/registration/api/types';

import type { RegisterStep } from '../api/register-edits';
import { identityChanges } from './identity-patch';
import { groupPopupErrors } from './popup-errors';
import {
  buildPopupPatch,
  currentStepMove,
  popupChanged,
  setPopupField,
  toggleExclusion,
  type PopupBase,
} from './register-popup';

const BASE: PopupBase = {
  status: 'In Development',
  hub_id: 'hub-1',
  leader_engineer_id: 'eng-1',
  actual_start_week: 10,
  actual_end_week: null,
  design_effort_weeks: null,
  lab_effort_weeks: 4,
  certification_testing_required: true,
  current_step_code: 'PDD-B',
  excluded: { 'PDD-A': false, 'PDD-B': false, 'PDD-C': false, 'PDD-E': true },
};
const ORDER = ['PDD-A', 'PDD-B', 'PDD-C', 'PDD-E'];

function step(code: string, over: Partial<RegisterStep> = {}): RegisterStep {
  return { step_code: code, step_name: code, kind: 'design', status: 'Not Started', step_excluded: false, applicable: true, excludable: true, is_current: false, ...over };
}

describe('register popup draft', () => {
  it('a value set back to the served one is dropped; nothing changed → no patch', () => {
    let d = setPopupField(BASE, {}, 'status', 'On Hold');
    expect(popupChanged(BASE, d)).toBe(true);
    d = setPopupField(BASE, d, 'status', 'In Development');
    expect(d).toEqual({});
    expect(buildPopupPatch('p', BASE, d, ORDER)).toBeNull();
  });

  it('toggling twice is no change; exclusions are sent in workflow order', () => {
    let d = toggleExclusion(BASE, {}, 'PDD-E');
    d = toggleExclusion(BASE, d, 'PDD-A');
    expect(buildPopupPatch('p', BASE, d, ORDER)).toEqual({
      project_id: 'p',
      step_exclusions: [
        { step_code: 'PDD-A', step_excluded: true },
        { step_code: 'PDD-E', step_excluded: false },
      ],
    });
    d = toggleExclusion(BASE, d, 'PDD-A');
    d = toggleExclusion(BASE, d, 'PDD-E');
    expect(d).toEqual({});
  });

  it('excluding the picked current step drops that pick', () => {
    let d = setPopupField(BASE, {}, 'current_step_code', 'PDD-C');
    d = toggleExclusion(BASE, d, 'PDD-C');
    expect(d).toEqual({ excluded: { 'PDD-C': true } });
  });

  it('only changed keys, a reset figure as null', () => {
    let d = setPopupField(BASE, {}, 'lab_effort_weeks', null);
    d = setPopupField(BASE, d, 'certification_testing_required', false);
    expect(buildPopupPatch('p', BASE, d, ORDER)).toEqual({
      project_id: 'p',
      lab_effort_weeks: null,
      certification_testing_required: false,
    });
  });

  it('current-step move is read from the served order', () => {
    const steps = ORDER.map((c) => step(c));
    expect(currentStepMove(steps, 'PDD-B', 'PDD-C')).toBe('forward');
    expect(currentStepMove(steps, 'PDD-B', 'PDD-A')).toBe('back');
    expect(currentStepMove(steps, 'PDD-B', 'PDD-B')).toBeNull();
    expect(currentStepMove(steps, null, 'PDD-A')).toBe('back');
  });
});

describe('popup error placement', () => {
  it('a step code lands on the chips or the current step, whichever the Save changed', () => {
    const e = [{ project_id: 'p', code: 'STEP_NOT_APPLICABLE', message: 'x' }];
    expect(Object.keys(groupPopupErrors(e, { exclusionsChanged: true, currentChanged: false }).byTarget)).toEqual(['steps']);
    expect(Object.keys(groupPopupErrors(e, { exclusionsChanged: false, currentChanged: true }).byTarget)).toEqual(['current_step_code']);
    const other = groupPopupErrors([{ project_id: 'p', code: 'SOMETHING_NEW', message: 'Server says no.' }], {
      exclusionsChanged: false,
      currentChanged: false,
    });
    expect(other.general).toEqual(['Server says no.']);
  });
});

describe('identity PATCH body', () => {
  const project = {
    name: 'Cooler A',
    external_code: null,
    hub_id: 'hub-1',
    leader_engineer_id: 'eng-1',
    comments: 'a\r\nb',
    scoring_tags: ['innovation'],
    tcogs_eur: 100,
  } as unknown as ProjectRead;

  it('keeps only changed identity keys; register keys never; empty = unset; CRLF = LF', () => {
    const body = {
      name: 'Cooler B',
      external_code: '',
      hub_id: 'hub-2',
      leader_engineer_id: 'eng-2',
      comments: 'a\nb',
      scoring_tags: ['innovation'],
      tcogs_eur: 100,
    } as never;
    expect(identityChanges(body, project)).toEqual({ name: 'Cooler B' });
  });
});
