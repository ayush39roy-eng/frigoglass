// Extraction tool for P1-T03 (seed data import) — NOT part of the runtime
// application. Run manually / re-run to regenerate `prototype_seed_data.json`
// if `reference/rpd-platform-prototype.html` ever changes.
//
// What this does and does not do:
//   - It extracts raw DATA RECORDS (engineer names/hubs/fte/allowed
//     categories, chamber codes/capacity/allowed stages, and the ~46 synthetic
//     demo project records the prototype embeds) from the prototype bundle,
//     because no client-provided seed data exists yet (see
//     docs/IMPLEMENTATION_PLAN.md P1-T03).
//   - It is NOT using the prototype as a scheduling-behaviour oracle. The
//     scheduler function embedded in the same bundle (`qm(...)`) is
//     deliberately NOT evaluated or ported here — see
//     docs/DOMAIN_RULES.md's "the prototype is a differential test oracle
//     during P2 only" and docs/MEMORY.md's Standing Decisions. This script
//     only evaluates the plain data-literal declarations (workflow template,
//     category multipliers reference, engineers, chambers, hub/lab-region
//     map, and the project records + the one small deterministic
//     `Jm.forEach(...)` expansion loop that appends 18 more project records
//     to the same array) — not the booking/greedy-scheduling logic that
//     follows it in the bundle.
//
// How the snippet boundaries below were chosen: `reference/rpd-platform-
// prototype.html` is a single minified esbuild bundle. The data-literal
// section runs from the first constant assignment after React's bootstrap
// (`var i=Di(tl()),Ie=31,Te=52,...`) up to (but not including) the scheduler
// function `function qm(e,t,n){...}` that immediately follows the last data
// declaration (`Jm.forEach(...)`). Everything in between is inert data plus
// one small, deterministic array-expansion loop — confirmed by manual review
// (P1-T03, docs/MEMORY.md) that no other project-generating loop/array exists
// anywhere else in the ~245KB bundle (checked via targeted grep for
// `Array.from`, `Array(`, `while(`, `Math.random`, and every `.forEach(`
// call site in the file).
//
// Usage: node extract_prototype_data.cjs
//   Reads:  ../../reference/rpd-platform-prototype.html (relative to this file)
//   Writes: ./prototype_seed_data.json
//
// Deliberately CommonJS (.cjs), not ESM: ES modules are implicitly strict
// mode, and a direct `eval()` of `var` declarations inside strict-mode code
// does NOT leak bindings into the enclosing scope (they're confined to the
// eval call itself) — which silently breaks this script's whole approach of
// evaluating the bundle's data-literal statements and then reading the
// resulting bindings back out. CommonJS modules are sloppy-mode by default,
// so `eval()` here behaves like a plain script-level eval and the bindings
// (`Jn`, `Hm`, `$m`, `qc`, etc.) become readable afterward, as intended.

const fs = require("node:fs");
const path = require("node:path");

const PROTOTYPE_PATH = path.join(__dirname, "..", "..", "reference", "rpd-platform-prototype.html");
const OUTPUT_PATH = path.join(__dirname, "prototype_seed_data.json");

const START_MARKER = "Ie=31,Te=52";
const END_MARKER = "function qm(";

function extractSnippet(content) {
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Could not locate the data-literal snippet in the prototype bundle. " +
        "The bundle's minified variable names / structure may have changed " +
        "since this extraction script was written — re-derive the markers " +
        "by hand (see docs/MEMORY.md P1-T03 entry) before trusting the output."
    );
  }
  // `var` was already emitted just before START_MARKER in the original file
  // (`var i=Di(tl()),Ie=31,...`) — re-add it here since we're slicing mid-
  // statement.
  return "var " + content.slice(start, end);
}

function main() {
  const content = fs.readFileSync(PROTOTYPE_PATH, "utf8");
  const snippet = extractSnippet(content);

  // eslint-disable-next-line no-eval -- controlled, local, non-runtime tooling
  eval(snippet);

  const data = {
    // 14-step workflow template (bare-letter step IDs, as embedded — the
    // seed script maps these to canonical "PDD-<letter>" IDs; do not rely on
    // this copy, backend/domain_constants.py's WORKFLOW_STEP_TEMPLATE_SEED is
    // the actual source used for the workflow_step_templates table).
    workflowTemplateBareIds: Jn,
    baseWeeksBareIds: jm,
    categoryMultipliers: Jc,
    hubLabRegion: Gr,
    hubs: qt,
    // eslint-disable-next-line no-undef
    engineers: Hm,
    // eslint-disable-next-line no-undef
    chambers: $m,
    projects: qc,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote ${data.projects.length} projects, ${data.engineers.length} engineers, ${data.chambers.length} chambers to ${OUTPUT_PATH}`);
}

main();
