import { describe, expect, it } from 'vitest';

import { makeMe } from '@/test/session';
import { resolveStartPage } from '@/stores/preferences';

import { ApiError } from '@/lib/api/client';

import { devLoginErrorMessage, LOGIN_FAILED_MESSAGE, loginFormError } from './test-logins';

describe('test logins (P46, ADR 0058 L1)', () => {
  it('asks for missing fields before any request', () => {
    expect(loginFormError('  ', 'x')).toBe('Enter your username or email.');
    expect(loginFormError('admin', '')).toBe('Enter your password.');
    expect(loginFormError('admin', 'admin')).toBeNull();
  });

  it('gives plain copy for 401 and 429', () => {
    expect(devLoginErrorMessage(new ApiError(401, 'x'))).toBe(LOGIN_FAILED_MESSAGE);
    expect(devLoginErrorMessage(new ApiError(429, 'x'))).toMatch(/Too many sign-in attempts/);
    expect(devLoginErrorMessage(new ApiError(429, 'x', undefined, 'RATE_LIMITED', 30))).toMatch(/Wait 30 s/);
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
