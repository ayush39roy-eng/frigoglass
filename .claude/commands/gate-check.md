---
description: Run the three-way phase gate (qa-inspector, workflow-auditor, security-auditor) for a phase and record the combined result.
---

Takes a phase ID (e.g., `P2`) as an argument: `$ARGUMENTS`.

1. Confirm every task in `docs/IMPLEMENTATION_PLAN.md` under this phase has status `DONE`. If any
   task is not `DONE`, stop and report which — a gate check does not run on an incomplete phase.
2. Invoke `qa-inspector` for this phase. Collect its PASS/FAIL verdict and full report (coverage,
   test results, golden-file status, contract tests, axe results — per the `qa-testing` skill's
   gate report format).
3. Invoke `workflow-auditor` for this phase. Collect its PASS/FAIL verdict — invariant assertions,
   reconciliation, and (for P2 specifically) oracle divergence classification completeness.
4. Invoke `security-auditor` for this phase. Collect its PASS/FAIL verdict — the findings table
   with severities; any High or Critical is an automatic FAIL.
5. Write a single combined gate entry to `docs/MEMORY.md` recording all three verdicts, each with
   its supporting detail (not just PASS/FAIL — the specifics each agent reported).
6. If all three are PASS: the phase is unblocked. Report this to the user and identify the first
   task of the next phase as the suggested next `/start-task`.
7. If any is FAIL: the phase does not advance. Create a remediation task at the top of the current
   phase in `docs/IMPLEMENTATION_PLAN.md`, describing exactly what failed and referencing the
   MEMORY.md entry with detail. Report this to the user.

Any agent (qa-inspector, workflow-auditor, security-auditor) has independent authority to FAIL —
this is not a majority vote. A single FAIL blocks the phase regardless of the other two verdicts.
