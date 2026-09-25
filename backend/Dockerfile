# Production image for the RPD backend — shared by three Docker Compose
# services (`api`, `worker`, `solver-worker`; see `../docker-compose.yml`).
# All three run the SAME image; only the container `command:` differs
# (FastAPI/Gunicorn for `api`, `celery -A workers.worker_app ...` for
# `worker`, `celery -A workers.celery_app ...` for `solver-worker`) — see
# `docker-compose.yml`'s comments on why this is a deliberate one-image,
# three-commands choice rather than three separate Dockerfiles.
#
# Multi-stage: the `builder` stage needs a C toolchain to build any wheels
# without prebuilt manylinux binaries; the final `runtime` stage ships only
# the installed virtualenv + application source, no compiler, no `dev`
# extras (pytest/ruff/mypy/testcontainers — see `pyproject.toml`'s
# `[project.optional-dependencies].dev`), no `.git`, no test suite.
#
# CLAUDE.md non-negotiable this image structurally enforces: "Never run
# CP-SAT inside the FastAPI process." This image's `api` CMD below runs
# Gunicorn/Uvicorn only — CP-SAT (`scheduling/cp_sat.py`) is only ever
# invoked by `workers/schedule_tasks.py`, which only the `solver-worker`
# container's `command:` (set in `docker-compose.yml`, not here) actually
# executes.

FROM python:3.13-slim AS builder

WORKDIR /build

# build-essential: some transitive deps (e.g. ortools' own dependencies,
# psycopg-adjacent C extensions pulled in by asyncpg's build fallback on
# platforms with no prebuilt wheel) may need a compiler. Removed entirely in
# the runtime stage below — never shipped.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

# Only the files `[tool.setuptools.packages.find]` in pyproject.toml
# actually packages (see that file's own "Flat layout" comment) — NOT
# `tests/`, `.venv/`, caches, or dotfiles. `.dockerignore` (this directory)
# excludes those at the build-context level too, but listing exact COPY
# sources here means an accidental new top-level dir doesn't silently end up
# in the image either.
#
# `domain_constants.py` is a standalone top-level module (not a package
# dir), so `packages.find`'s `include=[...]` list doesn't cover it either —
# it is never actually importable from the installed wheel below. It works
# at runtime purely because this stage's raw source tree is copied wholesale
# to `runtime`'s `/app` (WORKDIR, i.e. on `sys.path` via cwd) alongside the
# venv, matching this repo's own established "flat layout, run from
# `backend/` with `backend/` as the import root" convention
# (`pyproject.toml`'s "Packaging" comment) rather than "import the pip
# package from anywhere" — the `pip install .` step below exists to
# resolve/install third-party DEPENDENCIES into the venv, not to make this
# app's own modules importable as a distributed package.
COPY pyproject.toml ./
COPY domain_constants.py ./
COPY gunicorn_conf.py ./
COPY models ./models
COPY api ./api
COPY core ./core
COPY schemas ./schemas
COPY services ./services
COPY workers ./workers
COPY scheduling ./scheduling
COPY seed ./seed
COPY alembic ./alembic
COPY alembic.ini ./

# `pip install .` (not `-e .`, not `[dev]`) — installs this project's
# runtime dependencies (pyproject.toml's `[project.dependencies]` only) plus
# the project itself as an importable package, into the venv. No dev/test
# dependencies, no source left as an editable link.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir .

# --- runtime -----------------------------------------------------------
FROM python:3.13-slim AS runtime

# curl: used only by the HEALTHCHECK below to hit `/healthz`
# (`api/main.py`). postgresql-client: `pg_dump` — used ONLY by
# `workers/backup_tasks.py`'s nightly-backup Celery task (P6-T06), which
# only ever runs in the `worker` container per `docker-compose.yml`'s
# `beat_schedule`; harmless to also ship in `api`/`solver-worker` since all
# three containers share this one image (see this file's own header
# comment) and the binary is never invoked outside that one task. Debian
# trixie's own `postgresql-client` package tracks PostgreSQL 17 (matches
# `docker-compose.yml`'s `postgres:17-alpine`) — confirmed via
# `apt-cache policy` before pinning this, not assumed. Kept minimal
# otherwise — no build toolchain, no package manager cache left behind.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin appuser

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /build /app

WORKDIR /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# P6-T06: mount point for the `beat` service's `celerybeat-data` named
# volume (`docker-compose.yml`). Created + chowned here, before `USER
# appuser` below, because Docker auto-creates a missing bind/volume mount
# target as root:root at container start — which `appuser` (uid 1000,
# non-root, per this file's own security posture) would not be able to
# write the beat schedule shelve file into otherwise. Harmless on the
# `api`/`worker`/`solver-worker` containers, which never mount anything at
# this path.
RUN mkdir -p /var/lib/celery-beat && chown appuser:appuser /var/lib/celery-beat

USER appuser

EXPOSE 8000

# Applies to all three backend services (`api`, `worker`, `solver-worker` —
# see `docker-entrypoint.sh`'s own header comment for why none of them
# override `entrypoint:` in `docker-compose.yml`: secret resolution +
# `alembic upgrade head` must run before each container's real `command:`,
# and re-running migrations redundantly is a harmless no-op).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Gunicorn + Uvicorn workers, per `docs/PROJECT_AND_STACK.md` §3
# ("Gunicorn + Uvicorn") / §6 ("api (FastAPI, Gunicorn+Uvicorn workers)").
#
# `--config gunicorn_conf.py` (P6-T06): structured JSON logging for
# Gunicorn/Uvicorn's own access+error logs (bind/accesslog/errorlog are also
# set there; bind/worker-class are kept explicit here too so this CMD is
# self-describing even if someone reads it without opening that file).
#
# Deliberately NOT passing `--workers` here: a CLI `--workers` flag
# overrides `gunicorn_conf.py`'s `workers` setting, which defeats that
# file's env-driven `WEB_CONCURRENCY` sizing (needed on small hosts — see
# its comment for the OOM/502 failure mode this fixed on a 512MB instance).
CMD ["gunicorn", "api.main:app", \
     "--config", "gunicorn_conf.py", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--bind", "0.0.0.0:8000"]
