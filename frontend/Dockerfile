# Production image for the RPD frontend.
#
# Deployment choice (docs/PROJECT_AND_STACK.md §6 gives a choice: "served by
# nginx or a small static service"): this Dockerfile builds a SEPARATE,
# dedicated nginx-serving-static-files image, kept as its own
# `frontend` Docker Compose service (not merged into the top-level reverse
# proxy's `nginx` service/container). Rationale:
#   1. `docs/IMPLEMENTATION_PLAN.md`'s P6-T01 acceptance criteria enumerate
#      "all 8 services from the topology diagram" — nginx, api, frontend,
#      worker, solver-worker, postgres, redis, minio — i.e. `frontend` is
#      its own service, distinct from the reverse-proxy `nginx` service.
#   2. Keeping them separate means a frontend-only redeploy (new build)
#      never touches the reverse-proxy container/config, and TLS/HSTS/
#      ModSecurity work landing on the `nginx` service in P6-T02 has zero
#      overlap with this image.
# The root `nginx` service (see `../docker-compose.yml` /
# `../deploy/nginx/default.conf`) reverse-proxies `/` to this container and
# `/api/` to the `api` service — this image's own nginx never receives
# internet-facing traffic directly.
#
# Multi-stage: `builder` installs devDependencies (TypeScript, Vite, ESLint
# etc. — needed to actually run `pnpm build`) and produces `dist/`; the
# final `runtime` stage ships ONLY the built static assets on top of a bare
# `nginx:alpine` — no `node_modules`, no source maps (`vite.config.ts` has
# `build.sourcemap: false` already), no devDependencies.

FROM node:20-alpine AS builder

WORKDIR /app

# Pin pnpm via Corepack to match `pnpm-lock.yaml`'s `lockfileVersion: '9.0'`
# (pnpm 9.x) rather than whatever `npm i -g pnpm` would resolve to today.
RUN corepack enable && corepack prepare pnpm@9 --activate

# Dependency layer cached separately from source so an app-code-only change
# doesn't reinstall node_modules from scratch.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY index.html vite.config.ts postcss.config.js tailwind.config.ts components.json ./
COPY scripts ./scripts
COPY src ./src

# `VITE_API_BASE_URL` is baked into the built JS bundle at build time (Vite
# convention — see `src/lib/api/client.ts`), NOT read at container runtime.
# Default `/api`: the root `nginx` service's `location /api/ { proxy_pass
# http://api:8000/; }` (see `../deploy/nginx/default.conf`) strips that
# prefix before forwarding, exactly mirroring `vite.config.ts`'s own dev/E2E
# proxy rewrite (`path.replace(/^\/api/, '')`) — this is a continuation of
# an existing convention in this repo, not a new one invented here.
# Override at build time with `docker compose build --build-arg
# VITE_API_BASE_URL=...` if a deployment's reverse-proxy layout differs.
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# `build:no-budget` (not the default `build` script): the default `build`
# script also runs `scripts/check-bundle-size.mjs`, a CI-time budget gate
# (P4-era). It reads no runtime config and enforces a size ceiling — a
# useful lint in CI, but not a meaningful production-image-build-time gate,
# and failing an image build over a bundle-size regression that already
# passed CI would only ever be a redundant, later-to-fail-loud check.
RUN pnpm run build:no-budget

# --- runtime -------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# P6-T05 (Trivy container scan): the published `nginx:1.27-alpine` tag is a
# stale snapshot (last pushed 2025-04-16 as of this task) whose baked-in
# Alpine 3.21.3 OS packages (libssl3/libcrypto3, libxml2, libpng, libexpat,
# c-ares, musl, nghttp2, zlib) trail Alpine's own patched package repo by
# 34 CRITICAL/HIGH CVEs that already have fixed versions available upstream
# — confirmed via `trivy image --ignore-unfixed` before/after this line
# (34 findings -> 0). `apk upgrade` pulls those already-released patches
# from the same Alpine 3.21 release line (no OS version bump, no nginx
# version change, no application behavior change) — a safe, standard
# Docker hardening step, not a new dependency being introduced.
RUN apk update && apk upgrade --no-cache

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --retries=10 \
    CMD wget -q -O /dev/null http://localhost:80/ || exit 1
