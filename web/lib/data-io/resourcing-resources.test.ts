import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const m = await import("./resourcing-resources.ts");

test("assignment plan imports and exports under the resourcing grants", () => {
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.key, "resourcing-assignments");
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.supportsImport, true);
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.readPermission, "resourcing.read");
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.writePermission, "resourcing.manage");
  assert.equal(m.ASSIGNMENTS_DESCRIPTOR.scopedWrite, true);
});

test("retainer balances are export-only, per-currency, with no import surface", () => {
  assert.equal(m.RETAINER_BALANCES_DESCRIPTOR.supportsImport, false);
  assert.equal(m.RETAINER_BALANCES_DESCRIPTOR.readPermission, "retainers.read");
  const cols = m.RETAINER_BALANCE_FIELDS.map((f) => f.key);
  assert.deepEqual(cols, ["currency", "balance", "drawn"]);
  assert.equal("RETAINER_IMPORT_DESCRIPTOR" in m, false);
  assert.equal("DRAWDOWN_IMPORT_DESCRIPTOR" in m, false);
});

test("assignment refusals use the canonical engine refusal class", () => {
  const src = readFileSync(new URL("./resourcing-resources.ts", import.meta.url), "utf8");
  assert.ok(src.includes("resourcing/errors.ts"), "ResourcingRefusal resolves to the canonical engine errors module");
  const assignmentImports = src.split("\n").filter((line) => line.includes("resourcing/assignments.ts"));
  assert.ok(assignmentImports.length > 0 && assignmentImports.every((line) => !line.includes("ResourcingRefusal")));
});

test("export route passes actorId and no resourcing file reaches the trusted seam", () => {
  const route = readFileSync(new URL("../../app/api/data/export/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("actorId: authz.user.id"), "route threads the actor into resource reads");
  for (const rel of ["./resourcing-resources.ts", "../assistant/tools-resourcing.ts"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.equal(src.includes("readResolvedEntityListPageForView"), false, `${rel} never imports the trusted seam`);
    assert.equal(src.includes("executeEntityListPage"), false, `${rel} never imports the private executor`);
    assert.ok(src.includes("readEntityListPage"), `${rel} uses the safe reader`);
  }
});
