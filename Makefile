# RPD Web Application — Frigoglass
#
# Created in P2-T09 (qa-inspector) to give `make test` a single entry point that
# enforces BOTH coverage gates:
#   - backend-wide (excl. scheduling/, alembic/): >=70%
#   - backend/scheduling/ (correctness-critical core):            >=85%
# plus the frontend Vitest suite. See docs/MEMORY.md P2-T09.
#
# `make dev` (P6-T01): brings up the full production-shaped Docker Compose
# stack (`docker-compose.yml` — nginx, api, frontend, worker, solver-worker,
# postgres, redis, minio; see that file's own header comment for the full
# topology). Requires a `.env` at the repo root first (`cp .env.example .env`
# then fill in real secrets — see that file's comments); `docker compose`
# itself fails loudly (via `${VAR:?...}` interpolation) if a required one is
# missing, rather than silently starting with an empty value.

.PHONY: test test-backend test-scheduling test-frontend lint lint-backend lint-frontend dev dev-tls-cert dev-secrets dev-down dev-logs

test: test-backend test-scheduling test-frontend

# Backend-wide suite + >=70% gate (pyproject.toml addopts). Also collects
# tests/scheduling/ but does not measure the scheduling package here.
test-backend:
	cd backend && python -m pytest

# Scheduling package only, with the >=85% coverage gate (P2-T09).
test-scheduling:
	cd backend && python -m pytest -c pytest-scheduling.ini

test-frontend:
	cd frontend && pnpm test

lint: lint-backend lint-frontend

lint-backend:
	cd backend && ruff check . && mypy .

lint-frontend:
	cd frontend && pnpm lint && pnpm typecheck

# Full Docker Compose stack, built and started in the background.
# `dev-tls-cert` (P6-T02) is a prerequisite: it generates a throwaway
# DEV-ONLY self-signed TLS cert/key pair if one doesn't already exist (see
# deploy/tls/generate-dev-cert.sh) so `make dev`'s nginx service has
# something to bind-mount and terminate TLS with out of the box. It is a
# no-op if the pair already exists, and is NEVER the production artifact —
# see .env.example's RPD_TLS_CERT_PATH / RPD_TLS_KEY_PATH comments.
# `dev-secrets` (P6-T04) is likewise a prerequisite: it populates
# `secrets/*.txt` (Docker Compose `secrets:`, see docker-compose.yml's
# top-level `secrets:` block) with throwaway DEV-ONLY random values if they
# don't already exist (see deploy/secrets/generate-dev-secrets.sh) — a real
# deployment must generate its own via secrets/README.md and never reuse
# these.
dev: dev-tls-cert dev-secrets
	docker compose up -d --build

dev-tls-cert:
	./deploy/tls/generate-dev-cert.sh

dev-secrets:
	./deploy/secrets/generate-dev-secrets.sh

# Convenience counterparts — not in CLAUDE.md's "Standard commands" list,
# but a `make dev` with no way to tear down or tail logs is an incomplete
# workflow; kept minimal (no extra flags/behaviour beyond a thin wrapper
# around `docker compose`).
dev-down:
	docker compose down

dev-logs:
	docker compose logs -f
