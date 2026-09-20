import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./posting-subsidiaries.ts", import.meta.url), "utf8");

// The posting engine's spot lookup unions the direct quote with the inverted
// quote. Provider syncs write every directed pair for one as_of, so ties are
// the common case — and double rounding means the two candidates can differ
// (anchor quotes 1.0000/1.0820 store USD→X as 1.0820000000 while 1/(X→USD)
// rounds to 1.0820000001). Without a tiebreak the winner is plan-dependent:
// identical postings can convert alike amounts at different rates.
// fx-revaluation and labor-costing pin the rule — the DIRECT row wins — and
// the posting lookup must apply the same deterministic rule.
test("posting spot lookup breaks direct/inverse ties toward the direct quote", () => {
  const start = source.indexOf("const functionalRate");
  assert.ok(start >= 0, "functionalRate is defined");
  const end = source.indexOf("const stamped", start);
  const body = source.slice(start, end >= 0 ? end : undefined);
  assert.match(body, /select rate, as_of, 0 as priority from fx_rates/);
  assert.match(body, /select \(1 \/ rate\)::numeric\(19,10\) as rate, as_of, 1 as priority from fx_rates/);
  assert.match(body, /order by as_of desc, priority asc limit 1/);
});
