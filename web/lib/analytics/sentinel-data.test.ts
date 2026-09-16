import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./sentinel-data.ts", import.meta.url),
  "utf8",
);
const groupCte = source.slice(
  source.indexOf("), grouped as ("),
  source.indexOf("), qualified as ("),
);

test("sentinel duplicate groups key on the natural key including currency and reference", () => {
  // One finding per group: GROUP BY, not a pair self-join.
  assert.match(
    groupCte,
    /group by party_id, kind, currency, amt, refkey/,
  );
  assert.match(
    source,
    /lower\(trim\(coalesce\(reference_number, ''\)\)\) as refkey/,
  );
  // A USD 100 bill must never group with a CAD 100 bill.
  assert.doesNotMatch(
    groupCte,
    /join cand d2 on/,
  );
});

test("sentinel duplicate scan keeps a bounded date span and the period boundary rule", () => {
  assert.match(
    groupCte,
    /having count\(\*\) >= 2 and \(max\(ddate\) - min\(ddate\)\) <= \$\{DUPLICATE_THRESHOLD_DAYS\}/,
  );
  assert.match(
    source,
    /where \(first_date between \$\{from\} and \$\{to\} or last_date between \$\{from\} and \$\{to\}\)/,
  );
  assert.match(
    source,
    /coalesce\(document_date, posting_date\) >= \$\{DUPLICATE_SCAN_FROM\}/,
  );
  assert.match(
    source,
    /coalesce\(document_date, posting_date\) <= \$\{DUPLICATE_SCAN_TO\}/,
  );
});

test("sentinel vendor baselines partition by document currency", () => {
  assert.match(
    source,
    /partition by d\.party_id, d\.currency order by abs\(d\.total\) desc/,
  );
  assert.match(
    source,
    /join stats s on s\.party_id = pd\.party_id and s\.currency = pd\.currency/,
  );
});
