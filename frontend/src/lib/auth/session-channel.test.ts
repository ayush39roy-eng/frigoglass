import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEV_USER_STORAGE_KEY, getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import { FakeBroadcastChannel } from '@/test/fake-broadcast-channel';

import { IDLE_TIMEOUT_MS, LAST_ACTIVITY_KEY } from './idle';
import { bootstrapSession } from './session-bootstrap';
import {
  HANDSHAKE_TIMEOUT_MS,
  REMOTE_SIGNED_OUT_EVENT,
  SESSION_CHANNEL_NAME,
  broadcastSignedOut,
  parseSessionMessage,
  requestSessionFromOpenTab,
  startSessionChannel,
} from './session-channel';

/** Another tab of the app, signed in as `email`: answers every request. */
function openTabSignedInAs(email: string): FakeBroadcastChannel {
  const tab = new FakeBroadcastChannel(SESSION_CHANNEL_NAME);
  tab.onmessage = (event) => {
    const data = event.data as { type: string; id: string };
    if (data.type === 'session-request') tab.postMessage({ type: 'session-offer', id: data.id, email });
  };
  return tab;
}

/** Another tab that answers with whatever `reply` builds. */
function openTabReplying(reply: (id: string) => unknown): FakeBroadcastChannel {
  const tab = new FakeBroadcastChannel(SESSION_CHANNEL_NAME);
  tab.onmessage = (event) => {
    const data = event.data as { type: string; id: string };
    if (data.type === 'session-request') tab.postMessage(reply(data.id));
  };
  return tab;
}

const stops: Array<() => void> = [];

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  window.sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('dev user storage (ADR 0060 L1)', () => {
  it('keeps the signed-in user in sessionStorage only', () => {
    setDevUserEmail('admin@example.com');
    expect(window.sessionStorage.getItem(DEV_USER_STORAGE_KEY)).toBe('admin@example.com');
    expect(window.localStorage.getItem(DEV_USER_STORAGE_KEY)).toBeNull();
    expect(getDevUserEmail()).toBe('admin@example.com');
  });

  it('never reads an old localStorage login, and startup purges it', async () => {
    window.localStorage.setItem(DEV_USER_STORAGE_KEY, 'superadmin@example.com');
    expect(getDevUserEmail()).toBeNull();

    const boot = bootstrapSession();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    stops.push(await boot);

    expect(window.localStorage.getItem(DEV_USER_STORAGE_KEY)).toBeNull();
    expect(getDevUserEmail()).toBeNull();
  });
});

describe('message validation', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it.each([
    [{ type: 'session-request', id }, { type: 'session-request', id }],
    [{ type: 'session-offer', id, email: 'admin@example.com' }, { type: 'session-offer', id, email: 'admin@example.com' }],
    [{ type: 'signed-out' }, { type: 'signed-out' }],
  ])('accepts %j', (input, expected) => {
    expect(parseSessionMessage(input)).toEqual(expected);
  });

  it.each([
    null,
    'signed-out',
    [],
    { type: 'unknown' },
    { type: 'session-request' },
    { type: 'session-request', id: 'short' },
    { type: 'session-request', id: '<script>alert(1)</script>' },
    { type: 'session-offer', id, email: 'not-an-email' },
    { type: 'session-offer', id, email: 42 },
    { type: 'session-offer', id, email: 'admin@example.com', token: 'secret' },
    { type: 'session-offer', id, email: 'admin@example.com', roles: ['Super Admin'] },
    { type: 'signed-out', email: 'admin@example.com' },
  ])('rejects %j', (input) => {
    expect(parseSessionMessage(input)).toBeNull();
  });
});

describe('tab handshake (ADR 0060 L1)', () => {
  it('a new tab adopts the session of an open signed-in tab', async () => {
    openTabSignedInAs('admin@example.com');

    const boot = bootstrapSession();
    await vi.advanceTimersByTimeAsync(0);
    stops.push(await boot);

    expect(getDevUserEmail()).toBe('admin@example.com');
    expect(window.localStorage.getItem(DEV_USER_STORAGE_KEY)).toBeNull();
  });

  it('with no other tab open, nobody answers and the tab stays signed out (login page)', async () => {
    const boot = bootstrapSession();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
    let settled = false;
    void boot.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    stops.push(await boot);
    expect(getDevUserEmail()).toBeNull();
  });

  it('rejects a malformed offer, an offer for another request, and one from another origin', async () => {
    openTabReplying((id) => ({ type: 'session-offer', id, email: 'admin@example.com', roles: ['Super Admin'] }));
    openTabReplying(() => ({ type: 'session-offer', id: 'aaaaaaaa-other-request', email: 'admin@example.com' }));
    openTabReplying(() => 'admin@example.com');

    const result = requestSessionFromOpenTab();
    // A forged message from another origin, straight onto the requester's channel.
    const requester = FakeBroadcastChannel.open().find((c) => c.sent.length > 0);
    const requestId = (requester?.sent[0] as { id: string }).id;
    requester?.deliver({ type: 'session-offer', id: requestId, email: 'evil@example.com' }, 'https://evil.example');

    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    expect(await result).toBeNull();
  });

  it('the request carries only a type and an id', async () => {
    const result = requestSessionFromOpenTab();
    const requester = FakeBroadcastChannel.open()[0];
    expect(requester?.sent).toHaveLength(1);
    expect(Object.keys(requester?.sent[0] as object).sort()).toEqual(['id', 'type']);
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    await result;
    expect(requester?.closed).toBe(true);
  });

  it('an open tab answers with only its user email, and not when it is signed out or idle', async () => {
    setDevUserEmail('superadmin@example.com');
    stops.push(startSessionChannel({ onRemoteSignOut: vi.fn() }));

    const asking = requestSessionFromOpenTab();
    await vi.advanceTimersByTimeAsync(0);
    expect(await asking).toBe('superadmin@example.com');
    const responder = FakeBroadcastChannel.instances[0]!;
    expect(Object.keys(responder.sent[0] as object).sort()).toEqual(['email', 'id', 'type']);

    window.localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now() - IDLE_TIMEOUT_MS));
    const idleAsk = requestSessionFromOpenTab();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    expect(await idleAsk).toBeNull();

    window.localStorage.removeItem(LAST_ACTIVITY_KEY);
    setDevUserEmail(null);
    const signedOutAsk = requestSessionFromOpenTab();
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
    expect(await signedOutAsk).toBeNull();
  });
});

describe('sign-out broadcast (ADR 0060 L1)', () => {
  it('a sign-out in one tab reaches every other tab', async () => {
    const otherTab = vi.fn();
    const thirdTab = vi.fn();
    stops.push(startSessionChannel({ onRemoteSignOut: otherTab }));
    // A second responder in the same test stands for a third tab.
    const third = new FakeBroadcastChannel(SESSION_CHANNEL_NAME);
    third.onmessage = (event) => {
      if ((event.data as { type: string }).type === 'signed-out') thirdTab();
    };
    // The signing-out tab (no live channel of its own in this test: a temporary one is used).
    const signingOut = new FakeBroadcastChannel(SESSION_CHANNEL_NAME);
    signingOut.postMessage({ type: 'signed-out' });
    await vi.advanceTimersByTimeAsync(0);

    expect(otherTab).toHaveBeenCalledTimes(1);
    expect(thirdTab).toHaveBeenCalledTimes(1);
  });

  it('broadcastSignedOut posts exactly { type: "signed-out" } on the live channel', () => {
    stops.push(startSessionChannel({ onRemoteSignOut: vi.fn() }));
    broadcastSignedOut();
    const live = FakeBroadcastChannel.instances[0]!;
    expect(live.sent).toEqual([{ type: 'signed-out' }]);
  });

  it('the remote sign-out clears this tab’s user and tells the app shell', async () => {
    setDevUserEmail('admin@example.com');
    const shell = vi.fn();
    window.addEventListener(REMOTE_SIGNED_OUT_EVENT, shell);
    try {
      const boot = bootstrapSession();
      stops.push(await boot);
      new FakeBroadcastChannel(SESSION_CHANNEL_NAME).postMessage({ type: 'signed-out' });
      await vi.advanceTimersByTimeAsync(0);
      expect(getDevUserEmail()).toBeNull();
      expect(shell).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(REMOTE_SIGNED_OUT_EVENT, shell);
    }
  });

  it('ignores a forged signed-out from another origin', async () => {
    const onRemote = vi.fn();
    stops.push(startSessionChannel({ onRemoteSignOut: onRemote }));
    FakeBroadcastChannel.instances[0]!.deliver({ type: 'signed-out' }, 'https://evil.example');
    FakeBroadcastChannel.instances[0]!.deliver({ type: 'signed-out', extra: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onRemote).not.toHaveBeenCalled();
  });
});
