import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const autopilot = readFileSync(new URL("./saas-autopilot.ts", import.meta.url), "utf8");
const dunning = readFileSync(new URL("../dunning.ts", import.meta.url), "utf8");

test("SaaS autopilot runs dunning only for its simulation organization", () => {
  assert.match(autopilot, /import \{ runDunningForOrg \} from "\.\.\/dunning\.ts"/);
  assert.match(autopilot, /runDunningForOrg\(world\.orgId, today\)/);
  assert.doesNotMatch(autopilot, /\brunDunning\(/);
});

test("the org-scoped dunning runner does not perform global discovery", () => {
  const start = dunning.indexOf("export async function runDunningForOrg");
  assert.notEqual(start, -1);
  const end = dunning.indexOf("\nasync function runDunningInternal", start);
  assert.notEqual(end, -1);
  const scoped = dunning.slice(start, end);
  assert.match(scoped, /return runDunningInternal\(asOf, \[\{ orgId \}\]\)/);
  assert.doesNotMatch(scoped, /withBypass|select distinct policy\.org_id/);

  const internal = dunning.slice(end);
  assert.match(internal, /orgRows: ReadonlyArray<\{ orgId: string \}>/);
});
