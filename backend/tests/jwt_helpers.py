"""Test-only helper: a real RSA keypair + JWKS document + signed JWTs, so
`core.oidc.verify_token` is exercised against ACTUAL RS256 signature
verification in unit tests (not a bypassed/mocked crypto path) without a
network call to a real IdP — `core.oidc.get_jwks` is monkeypatched to return
this in-memory JWKS instead of fetching one over HTTP. The real network path
(discovery + JWKS fetch against a running Keycloak) is covered by this task's
own live smoke test, not by pytest (see docs/MEMORY.md P3-T02 entry).
"""

from __future__ import annotations

import json
import time

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

_KID = "test-key-1"


class FakeIdPKeypair:
    def __init__(self) -> None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self._private_pem = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode()
        jwk_json = RSAAlgorithm.to_jwk(key.public_key())
        jwk_dict: dict = json.loads(jwk_json)
        jwk_dict["kid"] = _KID
        jwk_dict["use"] = "sig"
        jwk_dict["alg"] = "RS256"
        self.jwks: dict = {"keys": [jwk_dict]}

    def sign(
        self,
        *,
        sub: str = "test-subject",
        iss: str = "https://issuer.test/realms/rpd",
        aud: str = "rpd-backend",
        email: str | None = "user@example.com",
        exp_delta_seconds: int = 3600,
        kid: str | None = _KID,
        extra_claims: dict | None = None,
    ) -> str:
        now = int(time.time())
        claims = {
            "sub": sub,
            "iss": iss,
            "aud": aud,
            "iat": now,
            "exp": now + exp_delta_seconds,
        }
        if email is not None:
            claims["email"] = email
        if extra_claims:
            claims.update(extra_claims)
        headers = {"kid": kid} if kid else {}
        return jwt.encode(claims, self._private_pem, algorithm="RS256", headers=headers)
