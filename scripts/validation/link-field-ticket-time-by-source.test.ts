import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(
  new URL("./link-field-ticket-time-by-source.ts", import.meta.url),
  "utf8",
);
const module = readFileSync(
  new URL("./field-ticket-time-links.ts", import.meta.url),
  "utf8",
);

test("the link tool plans and applies through the locking module", () => {
  assert.match(script, /resolveTimeTicketLinks\(/);
  assert.match(script, /classifyTimeTicketLinks\(/);
  assert.match(script, /applyTimeTicketLinks\(/);
  assert.doesNotMatch(
    script,
    /update time_entries/,
    "the script must not write entries from its stale plan read",
  );
  assert.doesNotMatch(
    script,
    /insert into audit_log/,
    "audit rows must derive from locked rows, not the plan",
  );
});

test("the apply requires a verified same-org operator", () => {
  assert.match(script, /--actor=<operator user uuid>/);
  assert.match(
    script,
    /--actor <user UUID> is required so every audit row carries its operator/,
  );
  assert.match(
    script,
    /select id from users where org_id = /,
    "the actor is verified against the target organization",
  );
  assert.match(
    script,
    /is not a user of this organization/,
    "a foreign actor refuses by name",
  );
  assert.doesNotMatch(
    script,
    /actorId: null/,
    "no apply path may record a null actor",
  );
});

test("the apply locks, re-verifies, and checks every write", () => {
  assert.match(module, /for update of te/, "entries are locked before verify");
  assert.match(
    module,
    /is now protected \(billed, invoiced, or GL-linked\)/,
    "a concurrent bill or post refuses by name",
  );
  assert.match(
    module,
    /moved from ticket/,
    "a concurrent ticket edit refuses instead of writing a false before-state",
  );
  assert.match(module, /no longer exists/, "a deleted entry refuses by name");
  assert.match(
    module,
    /\(audit\.rowCount \?\? 0\) !== batch\.length/,
    "an audit write matching zero rows is a failure",
  );
  assert.match(
    module,
    /\(updated\.rowCount \?\? 0\) !== batch\.length/,
    "an entry write matching zero rows is a failure",
  );
});
