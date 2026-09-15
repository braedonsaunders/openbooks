import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("manual flow routes enforce subsidiary scope before loading or running a subject", () => {
  assert.match(routeSource, /loadFlowSubjectSubsidiary\(subjectKind, subjectId, authz\.user\.orgId\)/);
  assert.match(routeSource, /guardSubsidiaryScope\([\s\S]*?loadFlowSubjectSubsidiary/);
});
