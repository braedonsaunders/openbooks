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
