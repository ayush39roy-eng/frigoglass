import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * P4-T09 (qa-inspector) — mints real Keycloak-issued access tokens for the six
 * dev test users (`dev/keycloak/rpd-realm.json` / `backend/seed/seed_dev_users.py`)
 * once per Playwright run, via the direct-access-grant (Resource Owner Password
 * Credentials) flow the `rpd-backend` client is configured for in dev.
 *
 * These are NOT the browser's real OIDC redirect flow (that's P6-T03, not built
 * yet) — this is the standard "get a real, validly-signed token for an E2E test
 * fixture without a browser redirect" technique, used only against the throwaway
 * dev Keycloak (`docker-compose.auth.dev.yml`). Real `backend/core/oidc.py`
 * signature/issuer/audience verification still runs on every request — this is
 * not an auth bypass, it's how the test obtains a legitimate credential.
 *
 * Tokens are written to `e2e/.tokens.json` (gitignored) for spec files to read.
 */

const KEYCLOAK_URL = process.env.RPD_E2E_KEYCLOAK_URL ?? 'http://localhost:8080';
const REALM = 'rpd';
const CLIENT_ID = 'rpd-backend';
const PASSWORD = 'TestPass123!';

export const DEV_USERS = {
  portfolioManager: 'alice.pm',
  hubPlanner: 'bob.hub',
  engineer: 'carol.eng',
  executiveViewer: 'dave.exec',
  auditor: 'erin.audit',
  admin: 'frank.admin',
} as const;

export type DevUserKey = keyof typeof DEV_USERS;

async function fetchToken(username: string): Promise<string> {
  const res = await fetch(
    `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: CLIENT_ID,
        username,
        password: PASSWORD,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `global-setup: failed to mint a token for '${username}' (${String(res.status)}). ` +
        'Is the dev Keycloak up (docker compose -f docker-compose.auth.dev.yml up -d)?',
    );
  }
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

export default async function globalSetup(): Promise<void> {
  const entries = await Promise.all(
    Object.entries(DEV_USERS).map(async ([key, username]) => {
      const token = await fetchToken(username);
      return [key, token] as const;
    }),
  );
  const tokens = Object.fromEntries(entries) as Record<DevUserKey, string>;
  const outPath = path.join(fileURLToPath(new URL('.', import.meta.url)), '.tokens.json');
  writeFileSync(outPath, JSON.stringify(tokens, null, 2));
}
