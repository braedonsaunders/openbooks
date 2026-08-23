import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

test("period-specific accounting logic uses exact ledger period identity", () => {
  const continuousClose = source("engine/src/continuous-close.ts");
  assert.match(
    continuousClose,
    /e\.period_id in \(select id from selected_periods\)/,
  );
  assert.match(continuousClose, /e\.period_id = \$\{period\.id\}/);
  assert.doesNotMatch(
    continuousClose,
    /e\.posting_date >= \$\{period\.starts_on\} and e\.posting_date <= \$\{period\.ends_on\}/,
  );

  const consolidation = source("engine/src/consolidation.ts");
  assert.match(consolidation, /and e\.period_id=\$\{periodId\}/);
  assert.doesNotMatch(
    consolidation,
    /e\.posting_date between \$\{period\.starts_on\} and \$\{period\.ends_on\}/,
  );

  const reports = source("web/lib/reports/trends.ts");
  assert.match(reports, /and e\.period_id = p\.id/);
});
