# Field encryption key rotation and production environment checklist

P27 (final security gate remediation, S26-H1 / S26-C1). Audience: the operator who owns the
hosted deployment (Render today, Frigoglass on-premise later). This document never contains a real
key, password or URL with credentials. Keep it that way.

## 1. What the key protects

`RPD_FIELD_ENCRYPTION_KEY` is one Fernet key. It encrypts, inside the database, every column that
uses `EncryptedString` / `EncryptedNumeric` (`backend/models/types.py`). Today that is four
columns on `projects`: `customer_name`, `tcogs_eur`, `selling_price_eur` and `gross_margin_pct`.
Anyone who has both a copy of the database and the key can read all four. If either leaked, rotate
both.

The rotation script `backend/scripts/rotate_field_key.py`:

- finds the columns from its constant list, `ENCRYPTED_COLUMNS`, and refuses to run if that list
  differs from the `EncryptedString` / `EncryptedNumeric` columns in the models. A new encrypted
  column therefore cannot be skipped silently: update the constant, and
  `tests/test_p27_rotate_field_key.py` will fail until you do;
- re-encrypts every non-null value with `MultiFernet([new, old]).rotate()` in **one transaction**,
  with rows locked (`SELECT ... FOR UPDATE`);
- verifies before committing:
  - every non-null value decrypts with the **new key alone**, to the same plaintext as before
    (compared by SHA-256);
  - no value still decrypts with the old key;
  - per column, the rotated count equals the non-null count (`COUNT(column)`);
- rolls back on any failure, so either every value is rotated or none is;
- keeps `updated_at` unchanged (a re-encryption is not a data change), and writes one
  `field_encryption_key.rotate` audit row that holds counts only;
- prints counts only. It never prints a key, a plaintext or a ciphertext. The engine hides SQL
  parameters in error messages;
- reads keys from the environment or from files, **never from argv**:

| Variable | Meaning |
|---|---|
| `RPD_FIELD_KEY_OLD` or `RPD_FIELD_KEY_OLD_FILE` | the key in use today (or a path to a file holding it) |
| `RPD_FIELD_KEY_NEW` or `RPD_FIELD_KEY_NEW_FILE` | the new key (or a path to a file holding it) |
| `RPD_DATABASE_URL` | the app's async DSN (`postgresql+asyncpg://...`) |

Set exactly one of each pair. Prefer the `_FILE` form, with the file mode `0600` and deleted
afterwards. Generate a new key with:

```
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" > new.key
```

Run this on a trusted machine or in the service shell. Never generate the key in a chat, a ticket
or a CI log.

`--dry-run` does everything, including verification, and then rolls back. Exit code: `0` success;
`1` refused or failed, with nothing changed; `2` bad arguments.

## 2. Rotation on Render (the hosted demo)

Do the steps in this order. Do not skip step 1: a leaked DB password plus the old key decrypts
every backup taken so far, whatever happens to the live data.

1. **Rotate the database password.** In the Render Postgres dashboard, rotate the credentials or
   create a new user, and update `RPD_DATABASE_URL` on the API service and on every worker that
   has it. Restrict inbound access: remove any "allow all" IP rule and allow only the Render
   services, plus the operator's IP for the duration of this procedure.
2. **Stop the writers.** Suspend the API web service and every Celery worker / solver worker /
   beat service. Nothing may write an encrypted column with the old key while the script runs.
   The static frontend can stay up.
3. **Back up.** Take a fresh backup in Render (manual backup / `pg_dump`) and confirm it finished.
   It is encrypted with the **old** key, so store it as sensitively as the key itself.
4. **Generate the new key** (section 1) and put the old and new keys in files the script can read.
   On Render, use a one-off shell on the API service (its image contains `scripts/`), or a trusted
   machine with network access to the DB and the backend checked out (`backend/.venv`).
5. **Dry run:**
   ```
   cd backend   # /app in the container
   RPD_FIELD_KEY_OLD_FILE=old.key RPD_FIELD_KEY_NEW_FILE=new.key \
     python -m scripts.rotate_field_key --dry-run
   ```
   `RPD_DATABASE_URL` is already set in the service shell. Check that each column shows
   `non-null N, rotated N, verified N`, and that the output ends with `DRY RUN ... Nothing was
   changed.`
6. **Run it for real.** Same command without `--dry-run`. Record the per-column and total counts:
   the re-gate needs an owner note that "rotated" equals "non-null".
7. **Swap the secret.** Set `RPD_FIELD_ENCRYPTION_KEY` to the new key on the API service **and on
   every worker** (they all decrypt). With Docker secrets on-premise, replace the secret file.
8. **Restart the API and all workers.** The key is cached per process (`lru_cache`), so a process
   that is not restarted keeps the old key and fails on the rotated values.
9. **Verify.** As an Admin, open a project with a customer name in the Workspace and in
   Registration: the values must show. In the API logs, look for `InvalidToken` errors: there must
   be none. Check the audit log for the `field_encryption_key.rotate` row and compare its counts
   with step 6.
10. **Destroy the old key** and the key files. Treat **every backup taken before step 6 as
    exposed**: the old key is known. Delete those backups where retention rules allow, or restrict
    access to them and record them as compromised. Exports already downloaded (CSV / XLSX in
    MinIO or on disk) contain **plaintext** financials, and no key rotation protects them: purge
    old `export_jobs` objects.
11. Restore the normal DB access rules (remove the operator IP).

If any step from 5 onwards fails, nothing has been committed: leave the old key in place, restart
the services on the old key, and investigate. The error names the table, the column and the row id
only.

**On-premise (Docker Compose):** the same steps apply. Stop `api` and the workers
(`docker compose stop api worker solver-worker beat`), back up (`docs/HANDOVER/BACKUP_RESTORE.md`),
run the script with
`docker compose run --rm -e RPD_FIELD_KEY_OLD_FILE=... -e RPD_FIELD_KEY_NEW_FILE=... api python -m scripts.rotate_field_key --dry-run`
(mount the key files read-only), replace the `field_encryption_key` secret file, then
`docker compose up -d`.

## 3. Production environment checklist (S26-C1)

Check this list before any deployment that can be reached from outside a developer's machine, the
Render demo included.

**Backend (API and every worker)**

- [ ] `RPD_DEV_MODE` **unset** or `false`. With it on, a request with no credentials runs as
      `frank.admin@example.com` (Admin), and `X-Dev-User-Email` lets the caller pick any account,
      Super Admin included. To check from outside: `GET /me` with no `Authorization` header must
      return **401**, and `GET /me/dev-users` must return **404**. `/docs`, `/redoc` and
      `/openapi.json` also return 404 outside dev mode (P27, S26-L2).
- [ ] `RPD_OIDC_ISSUER`, `RPD_OIDC_AUDIENCE`, and `RPD_OIDC_CLIENT_ID` where the IdP needs it, set
      to the real IdP (Entra ID primary, Keycloak fallback). Optional: `RPD_OIDC_JWKS_URL`.
- [ ] `RPD_FIELD_ENCRYPTION_KEY` (or `_FILE`) is a key that has never been shared. If it was ever
      pasted into chat, email or a ticket, rotate it (section 2).
- [ ] `RPD_DATABASE_URL` uses a password that has never been shared, and DB access is restricted
      to the app's network.
- [ ] `RPD_CORS_ORIGINS_MODE=replace` with `RPD_CORS_ORIGINS` set to exactly the frontend origin
      (on-premise behind same-origin nginx, it can stay empty). Without `replace`, the built-in
      localhost and demo origins stay allowed.
- [ ] The seeded `@example.com` dev users are **deactivated** (User / Role Admin, or
      `PATCH /users/{id}` with `{"is_active": false}`), after at least one real Super Admin exists.
      The last active Super Admin cannot be deactivated, so create the real one first.

**Frontend (build-time, `VITE_*` ships to the browser, so never a secret)**

- [ ] `VITE_API_BASE_URL` is the API origin, and `render.yaml`'s CSP `connect-src` names the same
      origin (`backend/tests/test_p27_render_csp.py` checks this).
- [ ] `VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID` are set to the IdP values, so the login page
      shows SSO and not the dev-user picker.
- [ ] Response headers: CSP, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`
      (`render.yaml` `headers:`, or `deploy/nginx/default.conf` on-premise). To check:
      `curl -sI https://<frontend>/ | grep -i -E 'content-security|x-frame|referrer|permissions'`.

**Known gap (be honest with the client):** the browser SSO round trip is not built yet.
`frontend/src/pages/login-sso.ts` builds the authorize redirect, but no callback or token exchange
exists. With dev mode off, the hosted demo therefore has **no interactive login** until that flow
is built. Until then, either keep the demo suspended, or put it behind an access proxy (Render
private service / Cloudflare Access / basic auth at a proxy) and never expose dev mode to the
internet.

**After an exposure (S26-C1):** review the Render logs and `audit_log_entries` for
`frank.admin@example.com` actions the owner did not make, and run the GDPR Art. 33 assessment (real
roster names are in the seed).
