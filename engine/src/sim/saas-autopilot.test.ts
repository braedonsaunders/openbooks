import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const autopilot = readFileSync(new URL("./saas-autopilot.ts", import.meta.url), "utf8");

test("SaaS autopilot runs dunning only for its simulation organization", () => {
  assert.match(autopilot, /import \{ runDunningForOrg \} from "\.\.\/receivables\/dunning\.ts"/);
  assert.match(autopilot, /runDunningForOrg\(world\.orgId, today\)/);
  assert.doesNotMatch(autopilot, /\brunDunning\(/);
});
