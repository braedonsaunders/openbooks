import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../../platform/db.ts";

// Static imports evaluate before the module body, so in-file assignments
// cannot guard the import-time database-environment resolution in db.ts.
// These tests never touch a real database — the runner below routes the
// services' SQL to in-memory fixtures. Blank the URL first and import
// dynamically, the same approach as authorization.test.ts.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const { actorPartyOf, SelfServiceError } = await import("./actor.ts");
const { resolveTeamEmploymentIds } = await import("./team-read.ts");
const { validateProfileChange } = await import("./profile-changes.ts");
const { HrmChangeRequestError, validateChangePayload } = await import("../change-requests.ts");

const ORG = "org-self-service-unit";
const TODAY = "2026-09-20";

interface Relationship {
  employmentId: string;
  managerEmploymentId: string;
  kind: string;
  recordedUntil: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface Fixtures {
  userParty: Map<string, string | null>;
  partyEmployments: Map<string, string[]>;
  relationships: Relationship[];
}

/** Fake runner: routes the self-service SQL to the fixture tables above. */
function fakeExec(fx: Fixtures): SqlExecutor {
  return {
    execute: (async (query: unknown) => {
      const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
      let text = "";
      const params: unknown[] = [];
      if (Array.isArray(chunks)) {
        for (const c of chunks) {
          if (typeof c === "string") {
            params.push(c);
            continue;
          }
          if (c && typeof c === "object" && "value" in c) {
            const v = (c as { value: unknown }).value;
            if (Array.isArray(v)) text += (v as string[]).join("");
            else params.push(v);
          }
        }
      }
      if (/from users/i.test(text)) {
        const userId = String(params[1]);
        const partyId = fx.userParty.has(userId) ? fx.userParty.get(userId) : undefined;
        return { rows: partyId === undefined ? [] : [{ partyId }] };
      }
      if (/from worker_employments/i.test(text)) {
        const partyId = String(params[1]);
        return { rows: (fx.partyEmployments.get(partyId) ?? []).map((id) => ({ id })) };
      }
      if (/from reporting_relationships/i.test(text)) {
        const managers = new Set<string>(JSON.parse(String(params[1])) as string[]);
        const today = String(params[2]);
        // The double reads the kind predicate OUT of the SQL under test —
        // a fake that hardcoded 'line' could never fail when the service
        // widens the predicate, so it would not test the refusal at all.
        const inMatch = text.match(/kind\s+in\s*\(\s*'([a-z_',\s]*)'\s*\)/i);
        const eqMatch = text.match(/kind\s*=\s*'([a-z_]+)'/i);
        const allowedKinds = new Set<string>(
          inMatch?.[1]
            ? inMatch[1].split("',").map((kind) => kind.replaceAll("'", "").trim())
            : eqMatch?.[1]
              ? [eqMatch[1]]
              : [],
        );
        const seen = new Set<string>();
        for (const rel of fx.relationships) {
          if (!managers.has(rel.managerEmploymentId)) continue;
          if (!allowedKinds.has(rel.kind)) continue;
          if (rel.recordedUntil !== null) continue;
          if (!(rel.effectiveFrom <= today && (rel.effectiveTo === null || rel.effectiveTo > today))) continue;
          seen.add(rel.employmentId);
        }
        return { rows: [...seen].sort().map((id) => ({ id })) };
      }
      throw new Error(`unexpected query in self-service unit fake: ${text.slice(0, 120)}`);
    }) as SqlExecutor["execute"],
  } as SqlExecutor;
}

interface FixtureIds {
  readonly managerUser: string;
  readonly managerParty: string;
  readonly managerEmployment: string;
  readonly reportA: string;
  readonly reportB: string;
  readonly reportC: string;
  readonly matrixOnly: string;
  readonly expired: string;
  readonly superseded: string;
  readonly future: string;
}

function teamFixtures(): { fx: Fixtures; ids: FixtureIds } {
  const ids = {
    managerUser: "user-manager",
    managerParty: "party-manager",
    managerEmployment: "employment-manager",
    reportA: "employment-a",
    reportB: "employment-b",
    reportC: "employment-c",
    matrixOnly: "employment-matrix",
    expired: "employment-expired",
    superseded: "employment-superseded",
    future: "employment-future",
  };
  const fx: Fixtures = {
    userParty: new Map([[ids.managerUser, ids.managerParty]]),
    partyEmployments: new Map([
      [ids.managerParty, [ids.managerEmployment]],
      ["party-a", [ids.reportA]],
      ["party-b", [ids.reportB]],
      ["party-c", [ids.reportC]],
    ]),
    relationships: [
      // Two live line reports of the manager.
      { employmentId: ids.reportA, managerEmploymentId: ids.managerEmployment, kind: "line", recordedUntil: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: ids.reportB, managerEmploymentId: ids.managerEmployment, kind: "line", recordedUntil: null, effectiveFrom: "2026-02-01", effectiveTo: "2027-02-01" },
      // C reports to A: transitive in v1, never the manager's team.
      { employmentId: ids.reportC, managerEmploymentId: ids.reportA, kind: "line", recordedUntil: null, effectiveFrom: "2026-03-01", effectiveTo: null },
      // Dotted lines never confer team visibility.
      { employmentId: ids.matrixOnly, managerEmploymentId: ids.managerEmployment, kind: "matrix", recordedUntil: null, effectiveFrom: "2026-01-01", effectiveTo: null },
      // Closed windows are history, not structure.
      { employmentId: ids.expired, managerEmploymentId: ids.managerEmployment, kind: "line", recordedUntil: null, effectiveFrom: "2025-01-01", effectiveTo: "2026-09-19" },
      { employmentId: ids.superseded, managerEmploymentId: ids.managerEmployment, kind: "line", recordedUntil: "2026-06-01T00:00:00Z", effectiveFrom: "2026-01-01", effectiveTo: null },
      { employmentId: ids.future, managerEmploymentId: ids.managerEmployment, kind: "line", recordedUntil: null, effectiveFrom: "2026-09-21", effectiveTo: null },
    ],
  };
  return { fx, ids };
}

test("actorPartyOf resolves the linked person and refuses an unlinked login by name", async () => {
  const { fx, ids } = teamFixtures();
  const exec = fakeExec(fx);
  assert.equal(await actorPartyOf(exec, ORG, ids.managerUser), ids.managerParty);
  await assert.rejects(() => actorPartyOf(exec, ORG, "user-ghost"), (error: unknown) => {
    assert.ok(error instanceof SelfServiceError);
    assert.equal(error.code, "NO_LINK");
    assert.match(error.message, /Admin → Users → Link person/);
    return true;
  });
  fx.userParty.set("user-unlinked", null);
  await assert.rejects(() => actorPartyOf(exec, ORG, "user-unlinked"), (error: unknown) => {
    assert.ok(error instanceof SelfServiceError);
    assert.equal(error.code, "NO_LINK");
    return true;
  });
  await assert.rejects(() => actorPartyOf(exec, "", ids.managerUser), (error: unknown) => {
    assert.ok(error instanceof SelfServiceError);
    assert.equal((error as InstanceType<typeof SelfServiceError>).code, "REFUSED");
    return true;
  });
});

test("team scope is exactly the live line reports: one level, no matrix, no history", async () => {
  const { fx, ids } = teamFixtures();
  const exec = fakeExec(fx);
  assert.deepEqual(await resolveTeamEmploymentIds(exec, ORG, ids.managerUser, TODAY), [
    ids.reportA,
    ids.reportB,
  ]);
});

test("team scope excludes the transitive report, the matrix-only edge, and closed windows individually", async () => {
  const { fx, ids } = teamFixtures();
  const exec = fakeExec(fx);
  const team = await resolveTeamEmploymentIds(exec, ORG, ids.managerUser, TODAY);
  for (const excluded of [ids.reportC, ids.matrixOnly, ids.expired, ids.superseded, ids.future]) {
    assert.ok(!team.includes(excluded), `${excluded} must not be team-visible`);
  }
  // A manager whose only edge is dotted-line holds no team.
  const matrixFx: Fixtures = {
    userParty: new Map([["user-dotted", "party-dotted"]]),
    partyEmployments: new Map([["party-dotted", ["employment-dotted-mgr"]]]),
    relationships: [
      { employmentId: "employment-dotted-report", managerEmploymentId: "employment-dotted-mgr", kind: "matrix", recordedUntil: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    ],
  };
  assert.deepEqual(await resolveTeamEmploymentIds(fakeExec(matrixFx), ORG, "user-dotted", TODAY), []);
});

test("profile proposals validate field by field", () => {
  const parsed = validateProfileChange({ kind: "profile_change", phone: "+1 555 0100" });
  assert.equal(parsed.phone, "+1 555 0100");
  assert.throws(() => validateProfileChange({ kind: "profile_change" }), /at least one of phone, email, address, or emergencyContact/);
  assert.throws(() => validateProfileChange({ kind: "profile_change", phone: "   " }), /phone must not be blank/);
  assert.throws(() => validateProfileChange({ kind: "profile_change", email: "not-an-address" }), /email must be a deliverable address/);
  assert.throws(
    () => validateProfileChange({ kind: "profile_change", emergencyContact: {} }),
    /at least one of name, relationship, or phone/,
  );
  assert.throws(() => validateProfileChange({ kind: "profile_change", address: { line1: "  " } }), /address\.line1/);
  const cleared = validateProfileChange({ kind: "profile_change", phone: null, emergencyContact: null });
  assert.equal(cleared.phone, null);
  assert.equal(cleared.emergencyContact, null);
});

test("the change-request kind vocabulary admits profile_change and lists it in refusals", () => {
  const parsed = validateChangePayload({ kind: "profile_change", email: "me@example.com" });
  assert.equal(parsed.kind, "profile_change");
  try {
    validateChangePayload({ kind: "promotion" });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof HrmChangeRequestError);
    assert.equal(error.code, "UNKNOWN_KIND");
    assert.match(error.message, /profile_change/);
  }
  try {
    validateChangePayload({ kind: "profile_change" });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof HrmChangeRequestError);
    assert.equal(error.code, "INVALID_PAYLOAD");
    assert.match(error.message, /at least one of phone, email, address, or emergencyContact/);
  }
});
