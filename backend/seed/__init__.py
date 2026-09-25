"""P1-T03 seed-data package.

Loads reference/lookup data (`workflow_step_templates`, `hubs`, from
`backend/domain_constants.py`) and the synthetic demo resource/project data
extracted from `reference/rpd-platform-prototype.html` (see
`prototype_seed_data.json` and `extract_prototype_data.cjs` for provenance)
into the schema built in P1-T01/P1-T02.

Deliberately excludes `currency_rates` — that table is seeded by P1-T04, not
this package. Deliberately does not touch `backend/scheduling/`.
"""
