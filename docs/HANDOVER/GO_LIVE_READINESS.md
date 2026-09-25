# Go-Live Readiness Assessment — RPD Web Application (Frigoglass)

**Author:** rpd-orchestrator · **Date:** 2026-09-08 · **Audience:** project owner + Frigoglass
portfolio / IT / security / DPO stakeholders.

**Bottom line:** the application is **build-complete and gate-clean through P6**. It is **not
go-live ready**, and the remaining gap is **entirely client-side inputs** — there is no outstanding
engineering work on the critical path that the team can do unilaterally. Five client decisions /
deliverables (§3) unblock the last three tasks (P7-T01 UAT, P7-T02 execution, P7-T04 final gate).

---

## 1. What is done

| Phase | Scope | Gate result (see `docs/MEMORY.md`) |
|---|---|---|
| P0 | Spec lock, open questions | Provisional proceed on stated defaults (project-owner authorised) |
| P1 | Data model, migrations, seed import | **PASS** — qa + security (2026-08-30) |
| P2 | Scheduling engine (greedy → golden tests → CP-SAT), invariants I1–I10, Monte Carlo | **PASS** — qa + workflow (2026-08-31) |
| P3 | API layer, OIDC auth mechanism, RBAC + hub-scoping, append-only audit log | **PASS** — qa + security (2026-08-31) |
| P4 | Design system + the six surfaces | **PASS** — qa + workflow (2026-09-01) |
| P5 | Scenarios, versioning, history, exports, notifications | **PASS** — qa + workflow (2026-09-05, re-run post P5-T10) |
| P6 | Security hardening, TLS/HSTS/WAF, Docker Compose, secrets, dependency scanning, observability | **security gate PASS**, zero Critical/High (2026-09-05) |
| P7 (partial) | P7-T03 handover docs · P7-T05 Audit Log UI · P7-T06 off-host backup mirror | DONE |

The full 11-service production stack stands up, migrations auto-run, the scheduler runs isolated
from FastAPI, financial fields are encrypted at rest, the audit log is DB-level immutable, and a
whole-app OWASP ASVS L2 pass found no Critical/High findings.

Handover documentation is complete: `DEPLOYMENT_RUNBOOK.md`, `BACKUP_RESTORE.md`, `ADMIN_GUIDE.md`,
and `DATA_MIGRATION_PLAN.md` (this last one plan-only — see §2).

---

## 2. What is left — and exactly why each is blocked

| Task | State | Blocking dependency |
|---|---|---|
| **P6-T03** — OIDC cutover to Frigoglass's real production IdP | BLOCKED | **OQ#9** — client has not named the IdP (Entra ID vs. Keycloak) or supplied an app registration / client credentials. The OIDC *mechanism* has no defect (independently security-audited); it is simply pointed at a dev/staging Keycloak today. |
| **P7-T01** — Client UAT against the six surfaces | TODO | Needs real client users, which needs real SSO (P6-T03 → OQ#9). Orchestrator judgment: UAT against the dev IdP is only acceptable if Frigoglass explicitly says so for their sign-off purposes. |
| **P7-T02** — Production data migration **execution** | Plan delivered; execution BLOCKED | **OQ#7** answer + the real portfolio spreadsheet + a column dictionary + confirmed engineer/chamber rosters. See `DATA_MIGRATION_PLAN.md` §8. |
| **P7-T04** — Final three-way go-live gate (qa + workflow + security) | TODO | Premature until P6-T03, P7-T01, and P7-T02 execution close. Running it now returns a foregone "not ready". |

There are **no** open remediation tasks, no failing gates, and no known Critical/High defects.

---

## 3. The client critical path (what Frigoglass must provide)

Ordered roughly by lead time. Items 1 and 2 are independent and can run in parallel.

1. **IdP decision + app registration** (Frigoglass IT / security) → resolves **OQ#9**, unblocks
   **P6-T03**. Needs: which IdP; issuer URL; client ID; client secret (if a confidential client);
   the redirect URI they'll allow; which claim carries group/role. Once supplied, P6-T03 is a
   small, well-understood `backend-builder` task (`.env` + `secrets/oidc_client_secret.txt`, both
   slots already prepared in `docker-compose.yml` / `secrets/README.md`), followed by a focused
   auth re-check.

2. **Spreadsheet + migration inputs** (Frigoglass portfolio manager) → resolves **OQ#7** in
   practice, unblocks **P7-T02 execution**. Needs: a confirmed answer on whether the spreadsheet is
   retired at cutover (one-shot load — the current plan) or stays authoritative during a transition
   (plan reopens); the frozen source file; a column dictionary; and confirmation of the real
   engineer roster (names, hubs, FTE, allowed categories) and chamber roster (codes, regions, max
   concurrent, allowed stages) for all 6 hubs. Then `migrate_production_data.py` is implemented
   against `DATA_MIGRATION_PLAN.md` §3.4 and the cutover runbook (§5) is executed.

3. **GDPR determination** (Frigoglass DPO, works-council consultation as needed) → resolves
   **OQ#8**. The engineer roster is loaded regardless (engineers are the scheduling entities);
   OQ#8 governs whether the app may *display / export* per-named-engineer utilisation. That control
   is already enforced server-side (withheld from every role except a self-scoped Engineer), so a
   "no" answer changes nothing operationally and a "yes" answer unlocks a currently-withheld view.
   Not on the go-live critical path unless Frigoglass wants named-utilisation views at launch.

4. **UAT scheduling** (Frigoglass + team) → **P7-T01**, once item 1 lands (or Frigoglass accepts
   UAT against the dev IdP).

5. **Final gate + go-live** → **P7-T04**, once 1, 2, and 4 are done. This is a team task, ~1 day.

**Not blocking go-live** (deferred, tracked, no client action needed now): **OQ#10** (may CP-SAT
drop a cert-at-risk P1 for portfolio gain) gates only the P4-T07 "Auto-assign" feature, which is
deliberately not wired to a user action; the greedy scheduler — which *is* what the app uses — is
unaffected.

---

## 4. Recommendation

Do **not** run P7-T04 yet. Its result is predetermined while P6-T03 / P7-T01 / P7-T02-execution
are open, and a recorded "FAIL — blocked on client" adds noise, not signal.

Instead:

- Send Frigoglass the §3 critical-path list as a single consolidated ask (IdP registration +
  spreadsheet/rosters + DPO position).
- Hold P7-T01 / P7-T02-execution / P7-T04 as a bundle that starts the moment items 1–2 land.
- When OQ#9 is answered: run P6-T03, then a focused security re-check, then schedule UAT.
- When OQ#7 + the spreadsheet land: implement `migrate_production_data.py` per the plan, dry-run
  against the real file, walk the cutover runbook, then P7-T04.

Estimated team effort once unblocked: P6-T03 ≈ 0.5 day + re-check; migration script ≈ 1–2 days +
the cutover window; P7-T04 ≈ 1 day. The pacing item is client turnaround on §3 items 1–2, not
engineering.

---

**Related documents:** `docs/IMPLEMENTATION_PLAN.md` (P7 section — task-level status),
`docs/OPEN_QUESTIONS.md` (#7 / #8 / #9 / #10 — the blocking questions in full),
`docs/HANDOVER/DATA_MIGRATION_PLAN.md` (P7-T02 detail), `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md` §5
(SSO current state), `docs/MEMORY.md` (every phase-gate entry cited in §1).
