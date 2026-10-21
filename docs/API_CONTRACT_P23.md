# API contract — P23: registration creates In Queue projects (Draft retired)

Owner: backend-builder (P23-T02). Consumer: frontend-builder (P23-T01). Date: 2026-10-21.
Rules: `docs/DOMAIN_RULES.md` "Project statuses and registration"; ADR 0034.

Error envelope (unchanged, `api/errors.py`): `{"detail": string | object | [{loc, msg, type}], "code"?: string}`.

## 1. `POST /projects` — register a project

Permission: Registration WRITE (Portfolio Manager, Hub Planner, Admin, Super Admin). Engineer,
Executive Viewer and Auditor get 403. This is unchanged.

The request body is `ProjectCreateRequest` and is **unchanged in shape**: unknown keys are rejected,
and `status` is still not accepted. What changed is which fields are required:

| Field | Required | Notes |
|---|---|---|
| `name`, `hub_id` | yes (schema) | a missing one is FastAPI's validation 422 (`detail: [{loc, msg, type}]`, no `code`) |
| `leader_engineer_id` | **yes (gate)** | must be an existing engineer, otherwise 422 `UNKNOWN_LEADER` |
| `category` | **yes (gate)** | must match the hub's workflow, otherwise 422 `CATEGORY_WORKFLOW_MISMATCH` (unchanged) |
| `type` | **yes (gate)** | |
| `actual_start_week` | **yes (gate)** | `>= 1` |
| `tcogs_eur`, `selling_price_eur` | **yes (gate)** | `>= 0`; encrypted at rest, never logged |
| `gross_margin_pct` | **yes (gate)** | encrypted at rest, never logged |
| `priority` | **yes (gate, new in ADR 0034)** | `P1`..`P4` or `Q`. The scheduler needs one for every schedulable project. |
| everything else | no | as before |

A gate field counts as missing when it is absent **or** `null`.

The server checks in this order and returns the first failure:

1. 401 or 403 (RBAC).
2. 422 `Unknown hub_id`.
3. 403 if the hub is outside the caller's scope.
4. 422 `HARD_GATE_FIELDS_MISSING`.
5. 422 `CATEGORY_WORKFLOW_MISMATCH`.
6. 422 `UNKNOWN_LEADER`.

**201** returns `ProjectRead`, which is unchanged in shape:

- `status` is always `"In Queue"`.
- `schedule_stale` is `true`.
- The 14 stage rows are created.
- One `project.create` audit row is written, with the financial fields `"<redacted>"`.
- No scheduler run is started.

## 2. The 422 `HARD_GATE_FIELDS_MISSING` (create, and the legacy submit)

```json
{
  "code": "HARD_GATE_FIELDS_MISSING",
  "detail": {
    "message": "Project cannot be registered: required fields missing.",
    "missing_fields": ["leader", "TCOGS", "priority"],
    "field_errors": {
      "leader_engineer_id": "Leader is required.",
      "tcogs_eur": "TCOGS is required.",
      "priority": "Priority is required."
    }
  }
}
```

- `field_errors` keys are the **request field names**. The values are display messages. Both
  `field_errors` and `missing_fields` list every missing field, in the fixed order: leader,
  category, type, actual start date, TCOGS, selling price, gross margin, priority.
- `missing_fields` holds the labels that the leave-Draft gate always returned. The labels are
  `leader`, `category`, `type`, `actual start date`, `TCOGS`, `selling price`, `gross margin` and
  `priority`.
- No submitted value is ever echoed.
- When nothing is written, there is no project, no stage row and no audit row.
- `POST /projects/{id}/submit` returns the same body. Its `message` is
  `"Project cannot leave Draft status: required fields missing."`. Before this contract, the submit
  body had no `code` and no `field_errors`; both additions are additive.

Frontend mirror: `frontend/src/surfaces/registration/components/required-fields-hint.ts`
(`REQUIRED_FIELD_LABELS`) must add `priority: 'priority'`. `requiredFieldErrorsFromApi` already
reads both `missing_fields` and the `field_errors` map.

## 3. `PATCH /projects/{id}`

`status: "Draft"` → **422** `DRAFT_RETIRED`. This applies even when the project is already a
legacy Draft row; nothing is written and no audit row is added.

```json
{"code": "DRAFT_RETIRED",
 "detail": [{"loc": ["body", "status"], "msg": "Draft is no longer a project status (ADR 0034).", "type": "value_error"}]}
```

`In Buyoff` and every other status are accepted as before. Moving a legacy Draft row to another
status through PATCH is still a 400, as before; use `/submit` for that.

## 4. Legacy Draft rows

Both endpoints keep working for historic Draft rows:

- `GET /projects/{id}/hard-gate-status` returns `{can_leave_draft, missing_fields}`, unchanged in
  shape. Priority is now in the list.
- `POST /projects/{id}/submit` takes `{target_status?}` (default `In Queue`). The error shape is the
  one in §2.

Nothing creates a new Draft row:

- create writes `In Queue`;
- PATCH rejects `Draft`;
- the ORM has no status default;
- the seed refuses Draft.

`GET /projects?status_=Draft` still filters normally.
