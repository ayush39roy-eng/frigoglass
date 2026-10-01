import { describe, expect, it } from 'vitest';

import { makeMe } from '@/test/session';
import { resolveStartPage } from '@/stores/preferences';

import { pickTestAccounts, TEST_LOGIN_PASSWORD, verifyTestLogin } from './test-logins';

const USERS = [
  { email: 'alex.admin@example.com', full_name: 'Alex Admin', roles: ['Admin' as const] },
  { email: 'sam.super@example.com', full_name: 'Sam Super', roles: ['Super Admin' as const] },
];

describe('verifyTestLogin', () => {
  it('accepts a seeded email (any case) with the shared test password', () => {
    const result = verifyTestLogin(' SAM.super@example.com ', TEST_LOGIN_PASSWORD, USERS);
    expect(result.ok && result.user.email).toBe('sam.super@example.com');
  });

  it('gives one message for an unknown email and for a wrong password', () => {
    const unknown = verifyTestLogin('nobody@example.com', TEST_LOGIN_PASSWORD, USERS);
    const wrong = verifyTestLogin('sam.super@example.com', 'nope', USERS);
    expect(unknown).toEqual(wrong);
    expect(unknown.ok).toBe(false);
  });

  it('asks for missing fields', () => {
    expect(verifyTestLogin('', 'x', USERS)).toEqual({ ok: false, error: 'Enter your email address.' });
    expect(verifyTestLogin('a@b.c', '', USERS)).toEqual({ ok: false, error: 'Enter your password.' });
  });
});

describe('pickTestAccounts', () => {
  it('returns one account per role in the given order', () => {
    expect(pickTestAccounts(USERS, ['Super Admin', 'Admin']).map((u) => u.email)).toEqual([
      'sam.super@example.com',
      'alex.admin@example.com',
    ]);
  });
});

describe('resolveStartPage', () => {
  it('keeps a start page the user can read, falls back to the Dashboard otherwise', () => {
    const me = makeMe();
    const blocked = makeMe({ permissions: { ...me.permissions, matrix: { read: false, write: false } } });
    expect(resolveStartPage(blocked, '/matrix')).toBe('/');
    expect(resolveStartPage(null, '/capacity')).toBe('/');
  });
});
