# Backup & Restore Procedure — RPD Web Application (Frigoglass)

**Audience:** Frigoglass on-premise ops team.

**Companion document:** `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md` (deployment, redeploy, known
operational gaps). This document covers only backup and restore.

**No secrets, credentials, or example real values appear in this document.** Secret files are
referenced by name only — see `secrets/README.md`.

---

## 1. What must be backed up vs. what is regenerated

| Item | Must be backed up? | Why |
|---|---|---|
| **Postgres data** (`postgres-data` volume / logical `pg_dump`) | **Yes — the primary system of record.** | All project, workflow-step, engineer, chamber, priority, schedule-run, and audit-log data lives here. This is irreplaceable. |
| **`secrets/field_encryption_key.txt`** | **Yes — separately, and with the highest operational priority in this whole document.** | This Fernet key is the only thing that can decrypt the encrypted-at-rest columns (TCOGS, gross margin, selling price, customer name — see `docs/DOMAIN_RULES.md` / `CLAUDE.md`'s non-negotiable). **If this file is lost after real data has been written, that data is permanently, cryptographically unrecoverable — a Postgres restore alone does not help, because the restored rows are still encrypted with a key nobody has anymore.** This file is not part of the Postgres backup and must be backed up through a separate, secure channel (see §5). |
| **`secrets/postgres_password.txt`, `secrets/minio_access_key.txt`, `secrets/minio_secret_key.txt`** | **Yes**, alongside the field-encryption key. | Needed to reconnect to a restored Postgres/MinIO with the same credentials, or to provision fresh ones and reconfigure — but note these three, unlike the field-encryption key, *can* be rotated after a restore (reconnect with new credentials); the field-encryption key cannot be rotated after the fact without an explicit re-encryption migration, which does not exist in this codebase. |
| **MinIO object storage** (`rpd-exports` bucket: generated export files; `rpd-backups` bucket: the nightly Postgres dumps themselves) | **Yes, both buckets**, though the `rpd-backups` bucket also has an automated off-host mirror as of P7-T06 (§4) once configured — see §4 for the important caveat that the mirror only protects the `rpd-backups` bucket, and only once an operator has actually pointed it at a real destination. | Exports are user-facing generated artifacts (CSV/PDF/etc.) that would otherwise need regenerating on demand; the backups bucket is where the nightly `pg_dump` output lives (see §2). |
| **`postgres-data` / `minio-data` Docker named volumes directly (filesystem-level)** | Optional, defense-in-depth only — not the primary mechanism this stack ships. | The application ships a logical `pg_dump`-to-MinIO backup (§2), which is portable and restorable via `pg_restore` independent of the exact host filesystem. A volume-level snapshot is a reasonable operator-added extra layer but is not what `deploy/backup/restore_from_minio.sh` / `backend/workers/restore_backup.py` are built around. |
| **`.env`** (config) | Recommended, low sensitivity. | No secrets live here (see `secrets/README.md`'s config-vs-secret split) — losing it means re-deriving config values (hostnames, bucket names, retention days) rather than losing data, but keeping a copy saves re-deriving them from scratch. |
| **`redis-data`** | **No — not needed.** | Redis here is the Celery broker/result backend and the solver-progress SSE pub/sub channel, all transient/in-flight state. Nothing in Redis is a system of record; a restored Postgres + MinIO with an empty Redis is a fully functional restore (in-flight Celery tasks/SSE subscriptions at the time of failure are lost, not silently corrupted). |
| **TLS certificate/key** | No — supplied by Frigoglass IT, managed outside this application's backup scope. | Re-obtain from IT if lost; not application data. |
| **Docker images (`rpd-backend`, `rpd-frontend`)** | No — regenerated from source. | `docker compose build` rebuilds both from the repository at any time; there is nothing image-specific to preserve that isn't already in version control. |
| **Alembic migration history / schema** | No — regenerated from source. | Schema is fully defined by `backend/alembic/versions/*.py`; a fresh Postgres + `alembic upgrade head` reproduces the empty schema exactly. Only the *data* inside that schema needs backing up. |
| **`backend/scheduling/` outputs (schedule-run results)** | Covered under Postgres data above — no separate mechanism. | Schedule-run rows/assignments are ordinary Postgres rows like everything else; nothing scheduling-specific needs its own backup path. This document does not touch `backend/scheduling/` itself, which is `algorithm-engineer`'s domain. |

## 2. How the automated backup works (already built, already running)

- **Mechanism:** a nightly `pg_dump` (custom format, `-Fc` — compressed and selectively/parallel
  restorable via `pg_restore`, chosen specifically so restore can use
  `pg_restore --clean --if-exists` rather than a hand-rolled "drop everything first" SQL preamble)
  uploaded to MinIO under the `postgres/` object-key prefix inside the `rpd-backups` bucket.
- **Who runs it:** the `beat` Celery-beat container enqueues the job on a schedule (defined in
  `backend/workers/worker_app.py`'s `beat_schedule`); the existing general-purpose `worker`
  container (not `solver-worker`, which is reserved for CP-SAT/greedy scheduler runs only) actually
  executes it. `beat` itself never executes tasks, only schedules them — this is why both
  containers exist in the topology (see the deployment runbook §2).
- **Retention:** governed by `RPD_MINIO_BACKUP_RETENTION_DAYS` (`.env`, default 30 days) via a
  MinIO-native bucket lifecycle `Expiration` rule applied to the `rpd-backups` bucket
  (`backend/core/minio_config.py::ensure_backups_bucket`) — MinIO itself deletes objects older than
  this window; there is no separate cleanup job to maintain.
- **What it never logs:** the database password (passed only via the `PGPASSWORD` subprocess
  environment variable, never a log line or command-line argument), the dump's actual row contents,
  or `pg_dump`'s raw stderr (only a return code and a short generic message on failure) — consistent
  with this codebase's "log identifiers/status, never raw payload" standard for anything that could
  carry financial/PII data.
- **Object naming:** UTC-timestamped object keys under the `postgres/` prefix (not guaranteed
  lexicographically sortable across a DST/leap-second edge case) — "latest" is correctly resolved
  by comparing each object's actual `last_modified` metadata, not by string-sorting key names (see
  `backend/workers/restore_backup.py::_resolve_object_key`).

**This mechanism is already live in the production stack as shipped — there is nothing an operator
needs to configure to make nightly backups start happening**, beyond the standard first-time
deployment steps in the deployment runbook (which bring up `beat` and `worker` like every other
service). What operators are responsible for is verifying it is actually running (§6) and
performing restores/drills when needed (§3, §7).

## 3. Restoring Postgres from a backup

**Restoring is always a deliberate, human-triggered action — never automatic.** The restore path
(`backend/workers/restore_backup.py`) is a plain script, not a Celery task, and cannot be reached
via `.delay()`, a schedule, or any API call — restoring over a live database is destructive by
nature and this is enforced structurally, not just by convention.

The operator-facing entry point is `deploy/backup/restore_from_minio.sh`, run from the repository
root on the deploying host (same prerequisites as bringing the stack up — a populated `.env` and
`secrets/*.txt`):

```
./deploy/backup/restore_from_minio.sh [OBJECT_KEY] [TARGET_HOST] [TARGET_PORT] [TARGET_DB] [TARGET_USER]
```

All five arguments are optional and default to restoring the **latest** backup **into this stack's
own live `postgres` service** — read that carefully before running it:

| Argument | Default | Meaning |
|---|---|---|
| `OBJECT_KEY` | `latest` | The most-recently-uploaded object under the `postgres/` prefix (by MinIO's own `last_modified` metadata). Pass an explicit key (e.g. a specific timestamped object name) to restore an older backup instead. |
| `TARGET_HOST` | `postgres` | **This stack's own Compose service.** Using the default will overwrite the live production database. For a non-destructive restore drill (§7), point this at a separate, disposable Postgres container on the same `rpd-internal` network instead. |
| `TARGET_PORT` / `TARGET_DB` / `TARGET_USER` | `5432` / `rpd` / `rpd` | Standard connection parameters; override only if restoring into a differently-named target. |

The script runs `pg_restore` inside a throwaway container built from the exact same
`rpd-backend:latest` image `api`/`worker`/`solver-worker` already use — it already has
`pg_restore` and this app's own configured `RPD_MINIO_*` credentials wired through the same Compose
secrets, so there is no second credential path to maintain for restores.

**Standard restore procedure (destructive — overwrites the live database):**

1. Confirm you actually intend to overwrite the live database. If this is a drill or a test, use
   §7's disposable-target procedure instead.
2. Notify affected users / put the application into a known-maintenance state if practical (there
   is no built-in maintenance-mode toggle in this stack; at minimum, expect in-flight requests
   during the restore to fail or see stale data momentarily).
3. Identify the object key to restore, if not the latest — list objects under the `postgres/`
   prefix in the `rpd-backups` bucket via the MinIO console or `mc ls` if you need a specific
   point-in-time backup rather than the most recent.
4. Run:
   ```
   ./deploy/backup/restore_from_minio.sh
   ```
   (or with an explicit `OBJECT_KEY` as the first argument).
5. Confirm the script's own logged status/counts (it deliberately never logs raw row content or the
   database password — only status, identifiers, and counts, per §2's logging standard). A nonzero
   exit code means the restore did not complete successfully; do not assume partial success.
6. Verify application-level health after restore: bring the application containers back up if they
   were stopped, hit `/healthz`, and spot-check that a known project/record is present and its
   financial fields decrypt correctly (see §5's field-encryption-key dependency — a restore with
   the **wrong** field-encryption key in place will restore the Postgres rows successfully but
   every encrypted column will fail to decrypt at the application layer; this is a field-encryption
   key mismatch, not a Postgres restore failure, and the fix is making sure
   `secrets/field_encryption_key.txt` on the restore target is the **same** key that was in use when
   the backup was taken).
7. Record the restore (what was restored, when, why, by whom) outside this application — the
   application's own append-only audit log records mutations made through the API, not
   infrastructure-level database restores, so this is an ops-team record-keeping responsibility, not
   something the app tracks for you.

## 4. MinIO object storage backup, and the off-host mirror (P7-T06)

The nightly Postgres backup (§2) is itself stored **inside MinIO**, which runs on the same host(s)
as everything else in this Compose stack (`minio-data` named volume). This was an important,
explicitly-flagged limitation of the stack when this document was first written (P7-T03):

**If the host's disk fails entirely, both the live Postgres data and every retained
`pg_dump`-to-MinIO backup would be lost together, because they lived on the same physical
storage.** A nightly backup that never leaves the host it protects only defends against logical
failures (accidental data deletion, a bad migration, application-level corruption) — it does not
defend against host/disk-level hardware failure, site loss, or ransomware that reaches the whole
host.

**P7-T06 closes most of this gap by adding an automated off-host mirror** — this section now
describes what actually ships, not just a recommendation.

### 4.1 What the mirror does

`backend/workers/backup_mirror_tasks.py`'s `mirror_backups_offhost` Celery task copies every object
in the local `rpd-backups` bucket to a second, off-host S3-compatible target, on the SAME
Celery-beat mechanism as the nightly `pg_dump` backup itself — scheduled for **03:00 UTC**, one hour
after the 02:00 UTC nightly dump (`backend/workers/worker_app.py`'s `beat_schedule`), so the previous
night's dump object is normally already present by the time the mirror runs. It is one-way
(source → destination), never deletes anything at either end, and skips objects that already exist
at the destination with a matching size — functionally equivalent to running `mc mirror` on a
schedule, implemented instead with the same `minio` Python SDK already used everywhere else in this
codebase (`backend/core/minio_config.py`) rather than shelling out to a separate `mc` binary this
image does not ship. If a particular night's `pg_dump` runs long and isn't finished by 03:00, that
object is simply picked up on the **following** night's mirror run instead of being missed — the
mirror task always mirrors the whole bucket, not just "last night's" object, and is deliberately not
chained directly off the pg_dump task's own success so a pg_dump failure never blocks mirroring of
previously-successful, still-unmirrored backups.

**The destination is Frigoglass's own infrastructure decision — this codebase does not hardcode
one.** Any S3-compatible target works (a second MinIO instance at another Frigoglass site, AWS S3,
or any other backup target Frigoglass IT already operates); nothing in the task assumes the
destination is MinIO specifically.

### 4.2 How to configure the destination

Until configured, the mirror task deliberately **no-ops** (logs `mirror_backups_offhost: skipped,
destination not configured` and returns `{"status": "skipped", ...}`) rather than failing the
nightly beat schedule — this is the state the application ships in today, since Frigoglass has not
yet chosen a destination.

To turn it on:

1. Set three **config** values (`.env` / `docker-compose.yml`, not secrets):
   `RPD_BACKUP_MIRROR_ENDPOINT` (`host:port`, no scheme), `RPD_BACKUP_MIRROR_BUCKET` (destination
   bucket name), and optionally `RPD_BACKUP_MIRROR_SECURE` (defaults to `true` — TLS on, since this
   traffic leaves the internal Docker network unlike everything else this stack talks to over MinIO).
2. Generate a **secret** access/secret key pair for the destination and place it in
   `secrets/backup_mirror_access_key.txt` / `secrets/backup_mirror_secret_key.txt` — see
   `secrets/README.md`'s "Future slot: off-host backup mirror" section for the exact steps, including
   the two commented-out `docker-compose.yml` lines that need uncommenting (the generic `_FILE`
   secret-resolution shim in `backend/docker-entrypoint.sh` already supports this convention with
   zero code changes, the same pattern already used for the OIDC confidential-client-secret slot).
3. Redeploy (`docker compose up -d`) so `worker`/`beat` pick up the new config/secrets.

All three config values default to blank and `RPD_BACKUP_MIRROR_SECURE` to `true` in
`.env.example` — a fresh deployment is safe (mirror simply no-ops) without any of this being set.

### 4.3 How to verify it is running

Same pattern as §6's verification of the primary nightly backup:

- Check `beat`'s logs (`docker compose logs beat`) for the `nightly-backup-offhost-mirror` schedule
  entry firing at 03:00 UTC.
- Check `worker`'s logs (`docker compose logs worker`) for `mirror_backups_offhost`'s own status log
  line — `"skipped"` (not yet configured), `"completed"` with `mirrored_count`/`skipped_count`, or a
  raised `RuntimeError` naming how many objects failed (a partial mirror is surfaced as a task
  FAILURE, not silently swallowed — see the task's own docstring).
- Independently confirm objects are landing in the destination bucket — via that provider's own
  console/CLI — rather than trusting log output alone, same principle as §6.
- **A `"skipped"` status is not evidence of a problem** if the destination genuinely has not been
  configured yet (§4.2) — check `RPD_BACKUP_MIRROR_ENDPOINT`/`RPD_BACKUP_MIRROR_BUCKET` are actually
  set in the deployed `.env` before treating repeated `"skipped"` runs as a defect.

### 4.4 Where this fits into the restore procedure

If the primary host is a **total loss** (the exact scenario this feature exists for): the local
Postgres data and the local `rpd-backups` bucket are both gone. **Restore from the off-host mirror
target instead of the local `rpd-backups` bucket**:

1. Stand up a fresh host with this stack's `docker-compose.yml` (or a disposable target — see §7).
2. Before running `deploy/backup/restore_from_minio.sh` (§3) — which reads from THIS deployment's
   own `rpd-backups` bucket via `RPD_MINIO_*` — either (a) temporarily point `RPD_MINIO_ENDPOINT`/
   `RPD_MINIO_ACCESS_KEY`/`RPD_MINIO_SECRET_KEY`/`RPD_MINIO_BACKUPS_BUCKET` at the off-host mirror
   target's connection details (the simplest option — `backend/workers/restore_backup.py` only ever
   talks to whatever `core/minio_config.py::get_minio_client()` resolves to, and does not care
   whether that's the "real" `rpd-backups` bucket or the mirror), or (b) manually copy the specific
   backup object you need from the off-host mirror target into a fresh `minio` service's
   `rpd-backups` bucket first (via that provider's own console/CLI), then proceed with §3 normally.
3. Proceed with §3's standard restore procedure from that point — object-key resolution (`latest` vs.
   an explicit key), `pg_restore`, and post-restore verification are all identical regardless of
   which bucket the object actually came from.
4. **The field-encryption key (§5) is still the separate, non-negotiable dependency it always is** —
   the off-host mirror only covers the `rpd-backups` bucket; it does not cover
   `secrets/field_encryption_key.txt`, which must be recovered through Frigoglass's own separate
   secure-credential channel (§5) regardless of which bucket the Postgres dump was restored from.

**The `rpd-exports` bucket is intentionally NOT mirrored off-host** by this task — as §4 already
notes, every object in it is regenerable on demand from live Postgres data, so it does not carry the
same total-loss risk the `rpd-backups` bucket does.

**The `rpd-exports` bucket** (generated CSV/PDF export files) is lower-priority to protect
specifically: every object in it is regenerable on demand by re-running the corresponding export
from the application UI/API against the live Postgres data. It is not the system of record for
anything; losing it is an inconvenience (users have to re-export), not data loss.

## 5. The field-encryption key — handle with the most care in this entire document

Repeating this because it is the single easiest way to turn a successful-looking restore into a
permanent, unrecoverable data-loss incident:

- `secrets/field_encryption_key.txt` is a Fernet key. It is **not** part of the Postgres backup, the
  MinIO backup, or any automated mechanism in this stack.
- It must be backed up **separately**, through a channel Frigoglass's own security/IT team
  controls (e.g. their existing enterprise secrets-management or secure-credential-storage
  process) — this document deliberately does not prescribe a specific tool, since that is
  Frigoglass's infrastructure decision, not this application's.
- **Restoring Postgres without also having the exact field-encryption key that was in effect when
  that backup was taken will not fail loudly at the `pg_restore` step** — the rows come back fine;
  only the application-level decryption of TCOGS/gross margin/selling price/customer name fails.
  Treat "restore succeeded but financial fields look wrong/unreadable" as a field-encryption-key
  mismatch, not a corrupted backup.
- If this key is ever genuinely lost with no backup, the encrypted columns on every affected row are
  permanently unrecoverable. There is no key-recovery mechanism in this codebase (by design — a
  recoverable key would defeat the point of encrypting the columns in the first place). The only
  way to avoid this outcome is having a real, tested backup of this specific file before it is
  needed.

## 6. Verifying backups are actually happening (do this periodically, not just once)

- Check the `beat` container's logs (`docker compose logs beat`) for evidence the nightly backup
  task is being enqueued on schedule.
- Check the `worker` container's logs (`docker compose logs worker`) for the backup task's own
  status log line (success/failure, never raw payload — see §2).
- Independently confirm objects are actually landing in the `rpd-backups` bucket — via the MinIO
  console, or `mc ls` against the bucket's `postgres/` prefix — rather than trusting log output
  alone. A log line claiming success with no corresponding object is itself worth investigating.
- Confirm the retention lifecycle is doing what is expected (objects older than
  `RPD_MINIO_BACKUP_RETENTION_DAYS` should not accumulate indefinitely) — spot-check bucket size
  growth over time.

## 7. Restore drill checklist

Perform this **on a schedule Frigoglass's ops team sets** (e.g. quarterly), and always before
relying on this procedure for a real incident for the first time. A restore drill is only
meaningful if it never touches the live production database.

- [ ] Stand up a **separate, disposable** Postgres container on the same `rpd-internal` Docker
      network as the live stack (not the stack's own `postgres` service) — this is the
      non-destructive target `deploy/backup/restore_from_minio.sh`'s `TARGET_HOST` argument exists
      for.
- [ ] Identify the backup object to restore (`latest`, or a specific older object key if testing a
      point-in-time restore).
- [ ] Run `./deploy/backup/restore_from_minio.sh <OBJECT_KEY> <disposable-target-host>` — confirm
      it targets the disposable container, **not** `postgres` (the default).
- [ ] Confirm the restore completes with a zero exit code and the script's own logged status
      indicates success.
- [ ] Connect to the disposable target directly (`psql`) and spot-check row counts on a few key
      tables (`projects`, `audit_log_entries`, `schedule_run_assignments` or equivalent) against
      expectations for that backup's approximate age.
- [ ] Confirm `audit_log_entries` on the restored copy still enforces its own append-only DB-level
      triggers (`UPDATE`/`DELETE`/`TRUNCATE` all rejected) — this is schema-level behavior baked
      into the migrations, not backup-specific, but worth reconfirming after any restore exercise
      since it's a core correctness/compliance guarantee of the audit log.
- [ ] Using the **same field-encryption key** that was active when the backup was taken, confirm at
      least one financial field (e.g. `customer_name` on a known project) decrypts to the expected
      plaintext — either via a real application instance pointed at the disposable database, or by
      independently decrypting a raw column value with the Fernet key outside the application (do
      not print/log the decrypted value anywhere beyond the operator's own terminal during this
      check — it is still commercially sensitive data even during a drill).
- [ ] Tear down the disposable target and any test credentials/network exposure created for the
      drill — do not leave a second live copy of production financial/customer data running
      indefinitely after the drill concludes.
- [ ] Record the drill's outcome (date, object key restored, pass/fail, any issues found) in
      Frigoglass's own ops record-keeping — not tracked automatically by this application.

---

**Related documents:** `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md` (stack topology, redeploy procedure,
known operational gaps), `secrets/README.md` (what each secret file is and how to generate it,
including the P7-T06 "Future slot: off-host backup mirror" section), `.env.example`
(`RPD_MINIO_BACKUPS_BUCKET`, `RPD_MINIO_BACKUP_RETENTION_DAYS`, `RPD_BACKUP_MIRROR_ENDPOINT`,
`RPD_BACKUP_MIRROR_BUCKET`, `RPD_BACKUP_MIRROR_SECURE` — the backup-relevant config values),
`docs/DOMAIN_RULES.md` / `CLAUDE.md` (financial-field encryption non-negotiable this whole document
is built around protecting).
