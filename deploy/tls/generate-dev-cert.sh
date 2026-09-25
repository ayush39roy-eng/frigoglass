#!/usr/bin/env sh
# DEV-ONLY convenience script (P6-T02). Generates a throwaway self-signed
# TLS certificate/key pair for local `make dev` / testing use ONLY.
#
# This is NEVER the production artifact. Frigoglass's on-premise deployment
# supplies its own real certificate/key at deploy time (see .env.example's
# RPD_TLS_CERT_PATH / RPD_TLS_KEY_PATH — point those at the real files;
# docker-compose.yml mounts whatever path they name into the `nginx`
# service's fixed in-container paths). There is no public-CA issuance flow
# here and none is assumed — see CLAUDE.md's opening paragraph: this app is
# hosted on Frigoglass's own servers, behind their corporate network, not a
# SaaS product with a public ACME-issuable domain.
#
# Idempotent: does nothing if a cert/key pair already exists at the target
# paths, so it is safe to call from `make dev` on every invocation.

set -eu

TLS_DIR="$(cd "$(dirname "$0")" && pwd)/dev"
CERT_PATH="${TLS_DIR}/server.crt"
KEY_PATH="${TLS_DIR}/server.key"

if [ -f "${CERT_PATH}" ] && [ -f "${KEY_PATH}" ]; then
    echo "deploy/tls/dev/server.{crt,key} already exist — skipping (dev self-signed cert, not production)."
    exit 0
fi

mkdir -p "${TLS_DIR}"

echo "Generating a DEV-ONLY self-signed TLS cert at ${CERT_PATH} (NOT for production use)."

openssl req -x509 -nodes -newkey rsa:2048 \
    -days 365 \
    -keyout "${KEY_PATH}" \
    -out "${CERT_PATH}" \
    -subj "/C=GR/O=Frigoglass RPD (DEV ONLY)/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:rpd.local,IP:127.0.0.1"

chmod 600 "${KEY_PATH}"

echo "Dev cert generated. This is a self-signed, browser-untrusted certificate for local testing only."
