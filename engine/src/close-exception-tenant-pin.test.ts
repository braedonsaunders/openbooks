import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const closeSource = readFileSync(new URL("./close.ts", import.meta.url), "utf8");

test("close exception upserts pin the known tenant on the run_id/code conflict write", () => {
  assert.match(
    closeSource,
    /insert into close_exceptions[\s\S]*?on conflict \(run_id, code\) do update set[\s\S]*?where close_exceptions\.org_id = \$\{orgId\}/,
  );
});

test("subsequent close_runs upserts pin the known tenant on the org_id/period_id/book_id conflict write", () => {
  assert.match(
    closeSource,
    /insert into close_runs[\s\S]*?on conflict \(org_id, period_id, book_id\) do update set[\s\S]*?where close_runs\.org_id = \$\{args\.orgId\}/,
  );
});
