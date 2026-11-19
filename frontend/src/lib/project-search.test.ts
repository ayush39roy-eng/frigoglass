import { describe, expect, it } from 'vitest';

import { narrowExceptBand } from '@/surfaces/matrix/lib/matrix-rows';
import type { PriorityMatrixRow } from '@/surfaces/matrix/api/types';
import { filterPicks, NO_PICK_FILTERS, type PickItem } from '@/surfaces/planning/whatif/import/project-picks';

import { compileSearch, matchesSearch, wildcardSource } from './project-search';

const NAMES = [
  'SPX 400 Cooler',
  'S-45 SZ Glass Door',
  'EEI>15% upgrade',
  'PepsiCo / Fresh',
  'ICOOL_2',
  'Back\\slash',
  'Ψυγείο Αθήνα',
  'Other fridge',
  'A (B) [C] {D} a.b+c^d$e|f',
];

function hits(term: string): string[] {
  const m = compileSearch(term);
  return m === null ? [...NAMES] : NAMES.filter((n) => m(n));
}

describe('compileSearch (P51-T02)', () => {
  it('returns null for a blank term (no filter)', () => {
    expect(compileSearch('')).toBeNull();
    expect(compileSearch('   ')).toBeNull();
    expect(compileSearch(null)).toBeNull();
    expect(compileSearch(undefined)).toBeNull();
  });

  it('keeps the substring behaviour without wildcards, case-insensitive', () => {
    expect(hits('sp')).toEqual(['SPX 400 Cooler']);
    expect(hits('  COOL  ')).toEqual(['SPX 400 Cooler', 'ICOOL_2']);
  });

  it('`*` matches any run of characters, anywhere in the value', () => {
    expect(hits('SP*')).toEqual(['SPX 400 Cooler']);
    expect(hits('sp*')).toEqual(['SPX 400 Cooler']);
    expect(hits('S*45')).toEqual(['S-45 SZ Glass Door']);
    expect(hits('pepsico*fresh')).toEqual(['PepsiCo / Fresh']);
    expect(hits('*')).toEqual(NAMES);
    expect(hits('nothing*here')).toEqual([]);
  });

  it('`?` matches exactly one character', () => {
    expect(hits('S?45')).toEqual(['S-45 SZ Glass Door']);
    expect(hits('S??45')).toEqual([]);
    expect(hits('?COOL_')).toEqual(['ICOOL_2']);
    expect(hits('ψυγ?ίο')).toEqual(['Ψυγείο Αθήνα']);
  });

  it('every other character is literal', () => {
    expect(hits('%')).toEqual(['EEI>15% upgrade']);
    expect(hits('_')).toEqual(['ICOOL_2']);
    expect(hits('\\')).toEqual(['Back\\slash']);
    expect(hits('EEI>15%')).toEqual(['EEI>15% upgrade']);
    expect(hits('eei>15% up*')).toEqual(['EEI>15% upgrade']);
    expect(hits('PepsiCo / Fresh')).toEqual(['PepsiCo / Fresh']);
    expect(hits('(b) [c] {d} a.b+c^d$e|f')).toEqual(['A (B) [C] {D} a.b+c^d$e|f']);
    expect(hits('(b)*a.b')).toEqual(['A (B) [C] {D} a.b+c^d$e|f']);
    // `.` is not a regex wildcard: "a.b" does not match "axb".
    expect(compileSearch('a.b*')!('axb')).toBe(false);
    expect(hits('ψυγείο*αθήνα')).toEqual(['Ψυγείο Αθήνα']);
    for (const ch of ['-', '/', '+', '&', "'", '"', '#', '>', '<', '=']) {
      expect(compileSearch(`x${ch}*`)!(`X${ch}y`), ch).toBe(true);
      expect(compileSearch(`x${ch}*`)!('xzy'), ch).toBe(false);
    }
  });

  it('builds a valid unicode regex source for every special character', () => {
    const specials = '%_\\-/+()[].&\'"#><={}^$|';
    expect(() => new RegExp(wildcardSource(specials), 'su')).not.toThrow();
    expect(new RegExp(`^${wildcardSource(specials)}$`, 'su').test(specials)).toBe(true);
  });

  it('matches when ANY value matches and ignores null / undefined', () => {
    const m = compileSearch('xsp-?')!;
    expect(m('Other fridge', 'XSP-9')).toBe(true);
    expect(m(null, undefined, 'none')).toBe(false);
    expect(matchesSearch('', 'anything')).toBe(true);
    expect(matchesSearch('S*45', 'S-45 SZ')).toBe(true);
  });
});

describe('client-side project searches use the shared matcher', () => {
  it('Prioritization Matrix rows: name or code', () => {
    const rows = [
      { project_name: 'SPX 400 Cooler', external_code: '24-0001' },
      { project_name: 'S-45 SZ Glass Door', external_code: '24-0002' },
      { project_name: 'Other', external_code: 'XSP-9' },
    ] as unknown as PriorityMatrixRow[];
    const filters = { hubText: '', leaderText: '', capacityFill: false, vipOnly: false };
    const names = (q: string) => narrowExceptBand(rows, { ...filters, q }).map((r) => r.project_name);
    expect(names('SP*')).toEqual(['SPX 400 Cooler', 'Other']);
    expect(names('S*45')).toEqual(['S-45 SZ Glass Door']);
    expect(names('24-000?')).toEqual(['SPX 400 Cooler', 'S-45 SZ Glass Door']);
    expect(names('')).toHaveLength(3);
  });

  it('What-if project picks', () => {
    const item = (name: string): PickItem =>
      ({ name, hub: 'R&D-Greece', category: 'A', priority: 'P1', status: 'In Queue', source: 'plan' }) as unknown as PickItem;
    const items = [item('SPX 400'), item('EEI>15% upgrade')];
    expect(filterPicks(items, { ...NO_PICK_FILTERS, query: 'sp*' }).map((i) => i.name)).toEqual(['SPX 400']);
    expect(filterPicks(items, { ...NO_PICK_FILTERS, query: '15%' }).map((i) => i.name)).toEqual(['EEI>15% upgrade']);
    expect(filterPicks(items, { ...NO_PICK_FILTERS, query: 'r&d-*' })).toHaveLength(2);
  });
});
