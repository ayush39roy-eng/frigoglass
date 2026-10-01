# ADR 0014: "Ask the agent" on the Project Workspace, via the Groq API

## Status

Accepted (2026-09-30), **interim/provisional** — see Consequences. Part of P10. Un-defers the
"Ask the agent" feature explicitly deferred at the P9 gate close (`docs/MEMORY.md`,
2026-09-27) at the project owner's explicit 2026-09-30 instruction, using Groq for now.

## Context

The client deck's Project Workspace concept included an "Ask the agent" affordance; P8/P9
deliberately left it unbuilt pending a client discussion, because this application is delivered
on-premise, behind Frigoglass's corporate network — sending any project data to a third-party
cloud LLM API is a real architectural departure from that posture, not a detail. The project owner
has now explicitly asked for it, naming Groq as the provider to use "for now." This ADR builds it
in a way that is safe to ship *today* and cheap to swap providers or turn off later, while
recording plainly that the data-egress decision itself still needs the client's sign-off before
this is a production default — this ADR does not retroactively answer that question.

## Decision

### 1. Scope: one project at a time, read-only over already-visible data

`POST /projects/{id}/ask-agent {question: str}` on the Project Workspace. It answers questions
about *that one project* using only data the asking principal can already see (per ADR 0012's
resolver) — it is a Q&A convenience over existing rows, not a new information disclosure.

### 2. Hard redaction, independent of the asker's own permissions

The context assembled for the LLM call **never** includes, regardless of the asker's role or
project-access level:

- Financial fields (TCOGS, gross margin, selling price, customer name) — CLAUDE.md's
  non-negotiable that these are commercially sensitive holds even harder for data leaving the
  network to a third party than it does for internal logging, so this is a blanket exclusion, not
  a permission check.
- Real engineer names or emails — assigned engineers are described by role/step
  (`"Design engineer for step PDD-B: assigned"`), never by name, matching the existing OQ #8
  withholding pattern used for comments/@mentions. This keeps Ask-the-agent inside the same GDPR
  posture already accepted for the rest of the app, rather than opening a new disclosure OQ #8's
  DPO gate has not seen.

Everything else already visible on the Workspace (status, health, dates, stage progress, kind,
skipped/frozen flags, non-financial Registration fields, file *names* and comment *bodies* — which
already went through the existing Markdown-sanitisation/no-HTML-passthrough pipeline) is fair
game, since the asker can already read it directly.

### 3. Provider: Groq, behind one narrow interface

`backend/services/ask_agent.py` exposes one function, `ask_about_project(context, question) ->
str`, calling Groq's OpenAI-compatible chat-completions endpoint with a fixed system prompt (states
the redaction rules explicitly, so the model does not need to be trusted to infer them — the
redaction already happened in Python before the prompt is built, this is belt-and-suspenders).
`RPD_GROQ_API_KEY` (never in the repo, `.env.example` ships blank, Docker Compose `secrets:`
pattern per ADR/P6-T04) and `RPD_GROQ_MODEL` (default a current Groq-hosted model, configurable).
The feature no-ops with a clear `503 AGENT_UNAVAILABLE` (matching the P7-T06 backup-mirror
precedent of "no-ops when unconfigured, does not fail the rest of the app") when the key is unset —
so an environment that never configures Groq is unaffected and never silently calls out to it.

### 4. Guardrails

- Rate-limited per user (reuse `services/rate_limit.py`'s existing comment-rate-limiter pattern —
  a Groq call costs real money and has real latency).
- Audit-logged: actor, project id, timestamp, and the question text (not financial/PII — see §2 —
  so this is safe to log, unlike the rest of the app's financial-field logging ban). The Groq
  response itself is not persisted; it is not a record of anything, only a synchronous answer.
- Not a chat history — each call is stateless, one question in, one answer out. No conversation
  state is stored, so there is nothing to leak on a second, unrelated request.
- Called synchronously inside the FastAPI request (an awaited outbound HTTP call, not a CPU-bound
  solve) — this does not conflict with the "never run CP-SAT inside the FastAPI process"
  non-negotiable, which is about blocking compute, not about awaited I/O to an external API.

## Consequences

- **This ADR is explicitly provisional on the data-egress question**, which is a client decision,
  not an engineering one. `docs/OPEN_QUESTIONS.md` gains #23 recording it: is sending
  (redacted) project data to a third-party US-hosted inference API (Groq) acceptable for the
  production, on-premise deployment, or only for internal dev/demo use. Until answered, this
  feature ships **off by default** (unconfigured `RPD_GROQ_API_KEY`) everywhere except the dev/demo
  environment the project owner explicitly asked to enable it in.
- `security-auditor` must verify the redaction is enforced server-side and cannot be bypassed by
  the question text itself (e.g. asking the agent to "repeat the customer name" must not work,
  because the customer name was never in the context to begin with — it is not a prompt-injection
  defence problem if the sensitive value is simply absent).
- Swapping providers later (should the client prefer an on-premise/self-hosted model instead of a
  third-party API) only touches `services/ask_agent.py`; the endpoint, redaction, rate-limit and
  audit-log behaviour are provider-agnostic by construction.
