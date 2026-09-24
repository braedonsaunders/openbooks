import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationSource } from "./source.ts";
import { runSync } from "./sync.ts";

// The check under test runs before any database work (validation precedes
// the run claim), so a stub source never gets touched: it only satisfies
// the parameter shape.
const probeSource = {
  name: "probe",
  refKey: "probe",
  baseCurrency: "USD",
} as unknown as MigrationSource;

const TRIGGERED_BY = "00000000-0000-4000-8000-000000000003";

function opts(actorId: string) {
  return {
    orgId: "00000000-0000-4000-8000-000000000001",
    connectionId: "00000000-0000-4000-8000-000000000002",
    postedChangeAuthorization: { actorId, authorizedAt: new Date() },
  };
}

test("a malformed posted-change actorId is refused before any sync work", async () => {
  // 36 dashes pass the old /^[0-9a-f-]{36}$/ check and would flow into the
  // automatic-correction audit attribution as if it were a user.
  await assert.rejects(
    runSync(probeSource, TRIGGERED_BY, opts("-".repeat(36))),
    /posted-change authorization is invalid/,
  );
  await assert.rejects(
    runSync(probeSource, TRIGGERED_BY, opts("not-a-uuid-at-all----------------")),
    /posted-change authorization is invalid/,
  );
});
