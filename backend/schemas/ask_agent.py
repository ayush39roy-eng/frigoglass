"""ADR 0014: "Ask the agent". See `api/routers/ask_agent.py`."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class AskAgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=2000)


class AskAgentResponse(BaseModel):
    answer: str
