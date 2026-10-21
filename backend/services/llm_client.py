"""A small, swappable chat-completions client (P18-T02, ADR 0031 follow-up).

`LlmClient` is the whole surface the What-if chat needs from a model: one
call that takes messages and tool definitions and returns text and/or tool
calls. `OpenAICompatibleClient` implements it for any OpenAI-compatible
`/chat/completions` endpoint: Groq today (`RPD_GROQ_API_KEY`), a self-hosted
model later by pointing `RPD_GROQ_BASE_URL` at it. Tests substitute a fake
that implements the same protocol; nothing else in the chat knows which
provider answers.

Logging (S18-L2): only the provider's status, error type and error code are
ever logged, each scrubbed of the configured key; never the error message
(some providers echo a key prefix in "invalid key"), never the request, which
carries scenario figures. A 200 that is not JSON or not the expected shape is
an `LlmProviderError` (an `httpx.HTTPError`), so it takes the same 502 path as
a transport failure (S18-L3).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from core.config import get_groq_settings

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT_SECONDS = 30.0


class LlmProviderError(httpx.HTTPError):
    """The provider answered, but not with a usable chat completion."""


def _scrub(text: object, secret: str) -> str:
    """`text` as a short string with the secret (and any 8+ char prefix of it,
    where providers echo one) removed."""

    out = str(text)[:80]
    if secret:
        out = out.replace(secret, "[redacted]")
        if len(secret) >= 8:
            out = out.replace(secret[:8], "[redacted]")
    return out


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    #: The raw JSON text the model produced. Parsed and validated by the caller.
    arguments: str


@dataclass(frozen=True)
class LlmReply:
    content: str | None
    tool_calls: tuple[ToolCall, ...] = field(default_factory=tuple)


class LlmClient(Protocol):
    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        *,
        max_tokens: int,
    ) -> LlmReply: ...


class OpenAICompatibleClient:
    def __init__(self, *, base_url: str, api_key: str, model: str) -> None:
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._api_key = api_key
        self._model = model

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        *,
        max_tokens: int,
    ) -> LlmReply:
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
            response = await client.post(
                self._url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json=payload,
            )
            if response.is_error:
                try:
                    err = response.json().get("error", {})
                    if not isinstance(err, dict):
                        err = {}
                except (ValueError, AttributeError):
                    err = {}
                logger.warning(
                    "llm chat-completions failed: status=%s type=%s code=%s model=%s",
                    response.status_code,
                    _scrub(err.get("type"), self._api_key),
                    _scrub(err.get("code"), self._api_key),
                    _scrub(self._model, self._api_key),
                )
            response.raise_for_status()
            try:
                data = response.json()
            except ValueError as exc:
                raise LlmProviderError("provider returned a non-JSON response") from exc
        return _parse_reply(data)


def _parse_reply(data: Any) -> LlmReply:
    try:
        message = data["choices"][0]["message"]
        raw_calls = message.get("tool_calls") or []
        calls = tuple(
            ToolCall(
                id=str(tc.get("id", "")),
                name=str(tc.get("function", {}).get("name", "")),
                arguments=str(tc.get("function", {}).get("arguments", "")),
            )
            for tc in raw_calls
        )
        content = message.get("content")
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise LlmProviderError("provider returned an unexpected response shape") from exc
    return LlmReply(content=str(content) if content else None, tool_calls=calls)


def configured_llm_client() -> LlmClient | None:
    """The deployment's client, or `None` when no API key is configured (the
    What-if forms keep working; only the chat answers 503 AGENT_UNAVAILABLE).
    """

    settings = get_groq_settings()
    if not settings.api_key:
        return None
    return OpenAICompatibleClient(
        base_url=settings.base_url, api_key=settings.api_key, model=str(settings.model)
    )
