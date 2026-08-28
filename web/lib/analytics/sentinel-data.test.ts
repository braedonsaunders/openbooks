import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./sentinel-data.ts", import.meta.url),
  "utf8",
);
const pairCte = source.slice(
  source.indexOf("), pairs as ("),
  source.indexOf("), top as ("),
);

test("sentinel duplicate pairs include either member when a pair crosses the report boundary", () => {
  assert.match(
    pairCte,
    /where \(d1\.ddate between \$\{from\} and \$\{to\} or d2\.ddate between \$\{from\} and \$\{to\}\)/,
  );
  assert.doesNotMatch(
    pairCte,
    /where d1\.ddate >= \$\{from\} and d1\.ddate <= \$\{to\}/,
  );
});

test("sentinel duplicate scan keeps deterministic pairing and a bounded date window", () => {
  assert.match(
    pairCte,
    /and d1\.id < d2\.id and abs\(d2\.ddate - d1\.ddate\) <= \$\{DUPLICATE_THRESHOLD_DAYS\}/,
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
