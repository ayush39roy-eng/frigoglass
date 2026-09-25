#!/bin/sh
# DEV-ONLY throwaway secret generator (P6-T04). Mirrors
# `deploy/tls/generate-dev-cert.sh`'s (P6-T02) own pattern: idempotent (never
# overwrites a file that already exists), wired into `make dev` as a
# prerequisite, and NEVER the production artifact — see `secrets/README.md`
# for what a real deployment must generate/populate instead.
#
# Populates `secrets/*.txt` (gitignored — see root .gitignore) with random,
# single-use-for-local-dev-only values so `make dev` works out of the box
# without an operator manually creating four files first. Real deployments
# must replace every one of these before going anywhere near production
# data — see secrets/README.md's own table.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECRETS_DIR="$REPO_ROOT/secrets"

mkdir -p "$SECRETS_DIR"

write_if_missing() {
    file="$1"
    generator="$2"
    if [ -f "$file" ]; then
        echo "generate-dev-secrets: $file already exists, leaving as-is."
        return
    fi
    eval "$generator" > "$file"
    chmod 600 "$file"
    echo "generate-dev-secrets: wrote throwaway DEV-ONLY value to $file"
}

write_if_missing "$SECRETS_DIR/postgres_password.txt" "openssl rand -base64 32"
# A Fernet key is exactly urlsafe-base64(32 random bytes) with standard
# padding — `openssl rand -base64 32` produces the same 44-char base64
# encoding of 32 raw bytes; `tr` remaps the two non-urlsafe alphabet
# characters. Deliberately openssl-only (no python3/`cryptography` import
# assumed present on the HOST running this script — only inside the
# backend container/venv) to mirror `deploy/tls/generate-dev-cert.sh`'s own
# "host tooling is just openssl" convention.
write_if_missing "$SECRETS_DIR/field_encryption_key.txt" \
    "openssl rand -base64 32 | tr '+/' '-_'"
write_if_missing "$SECRETS_DIR/minio_access_key.txt" "openssl rand -hex 16"
write_if_missing "$SECRETS_DIR/minio_secret_key.txt" "openssl rand -base64 32"

echo "generate-dev-secrets: done. These are DEV-ONLY values — see secrets/README.md before any real deployment."
