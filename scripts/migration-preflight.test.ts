/**
 * The preflight loader's refusal-relevant behavior lives in pure helpers in
 * migration-preflight.ts (bootstrap.ts runs main() on import, so it cannot
 * be imported here): decision resolution, the .none adequacy bar, the
 * bounded statement timeout, deferred-vs-real error classification, and
 * finding-shape validation. The evaluator itself runs against a fake
 * database client (mock the database, never validation): it must prove the
 * read-only transaction shape — BEGIN READ ONLY ... ROLLBACK — and that a
 * malformed preflight refuses by name instead of reporting clean.
 */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  PREFLIGHT_STATEMENT_TIMEOUT_DEFAULT_MS,
  assertReadOnlyPreflight,
  earlierPendingCreatesObject,
  evaluatePreflight,
  formatFinding,
  isAdequateNoneReason,
  isDeferredPreflightError,
  ordinalOf,
  preflightDecisionFor,
  preflightStatementTimeoutMs,
  validateFindingRows,
} from "./migration-preflight.ts";

function decisions(...files: string[]): ReadonlySet<string> {
  return new Set(files);
}

test("decision resolution prefers exactly one file and refuses both", () => {
  assert.deepEqual(preflightDecisionFor("0296_x.sql", decisions("0296_x.sql")), {
    kind: "sql",
    basename: "0296_x.sql",
    filename: "0296_x.sql",
  });
  const none = preflightDecisionFor("0242_x.sql", decisions("0242_x.none"));
  assert.equal(none.kind, "none");
  assert.deepEqual(preflightDecisionFor("0242_x.sql", decisions()), {
    kind: "missing",
    basename: "0242_x.sql",
  });
  assert.throws(
    () => preflightDecisionFor("0296_x.sql", decisions("0296_x.sql", "0296_x.none")),
    /both 0296_x\.sql and 0296_x\.none exist/,
  );
});

test("ordinal parsing accepts only the four-digit migration shape", () => {
  assert.equal(ordinalOf("0242_guarded.sql"), 242);
  assert.equal(ordinalOf("0242_guarded.none"), null);
  assert.equal(ordinalOf("not-a-migration.sql"), null);
});

test("a .none reason is adequate at 20 non-whitespace characters", () => {
  assert.equal(isAdequateNoneReason("a".repeat(20)), true);
  assert.equal(isAdequateNoneReason(`  ${"a".repeat(19)}  \n`), false);
  assert.equal(isAdequateNoneReason(""), false);
});

test("the preflight statement timeout defaults to five minutes and stays bounded", () => {
  assert.equal(preflightStatementTimeoutMs({}), PREFLIGHT_STATEMENT_TIMEOUT_DEFAULT_MS);
  assert.equal(PREFLIGHT_STATEMENT_TIMEOUT_DEFAULT_MS, 300_000);
  assert.equal(preflightStatementTimeoutMs({ OPENBOOKS_PREFLIGHT_STATEMENT_TIMEOUT_MS: "60000" }), 60_000);
  for (const bad of ["forever", "0", "-5", "99999999999", "12.5"]) {
    assert.equal(
      preflightStatementTimeoutMs({ OPENBOOKS_PREFLIGHT_STATEMENT_TIMEOUT_MS: bad }),
      PREFLIGHT_STATEMENT_TIMEOUT_DEFAULT_MS,
      bad,
    );
  }
});

test("only undefined-table and undefined-column defer a preflight", () => {
  assert.equal(isDeferredPreflightError({ code: "42P01" }), true);
  assert.equal(isDeferredPreflightError({ code: "42703" }), true);
  for (const code of ["42501", "57014", "55P03", undefined]) {
    assert.equal(isDeferredPreflightError({ code }), false, String(code));
  }
});

test("a preflight is deferred only when an earlier pending migration creates the object", () => {
  const missingTable = Object.assign(new Error('relation "payroll_remittance_coverage" does not exist'), {
    code: "42P01",
  });
  const creator = "CREATE TABLE public.payroll_remittance_coverage (id uuid PRIMARY KEY);";
  assert.equal(earlierPendingCreatesObject(missingTable, [creator]), true);
  assert.equal(earlierPendingCreatesObject(missingTable, ["select 1;"]), false);
  assert.equal(earlierPendingCreatesObject(missingTable, []), false);

  const missingColumn = Object.assign(
    new Error('column "executed_snapshot" of relation "lien_waivers" does not exist'),
    { code: "42703" },
  );
  const adder = "ALTER TABLE public.lien_waivers ADD COLUMN executed_snapshot jsonb;";
  assert.equal(earlierPendingCreatesObject(missingColumn, [adder]), true);
  assert.equal(
    earlierPendingCreatesObject(missingColumn, ["ALTER TABLE public.other ADD COLUMN executed_snapshot jsonb;"]),
    false,
  );
  assert.equal(earlierPendingCreatesObject(new Error("permission denied"), [creator]), false);
});

test("well-formed finding rows pass through with their migration attached", () => {
  const rows = [
    {
      code: "0296.malformed_remittance_marker",
      severity: "refuse",
      subject: "stub 123 (PAY-456)",
      detail: "the marker matches neither shape",
      remedy: "fix the marker, then upgrade",
    },
  ];
  assert.deepEqual(validateFindingRows("generated/0296_x.sql", "0296", rows), [
    { migration: "generated/0296_x.sql", ...rows[0], severity: "refuse" },
  ]);
});

test("a malformed preflight row refuses by name instead of reporting clean", () => {
  const good = {
    code: "0296.malformed_remittance_marker",
    severity: "refuse",
    subject: "s",
    detail: "d",
    remedy: "r",
  };
  assert.throws(() => validateFindingRows("generated/0296_x.sql", "0296", [{ ...good, detail: 7 }]), /detail/);
  assert.throws(() => validateFindingRows("generated/0296_x.sql", "0296", [{ ...good, detail: "" }]), /detail/);
  assert.throws(
    () => validateFindingRows("generated/0296_x.sql", "0296", [{ ...good, code: "bad code!" }]),
    /must look like <ordinal>\.<snake_reason>/,
  );
  assert.throws(
    () => validateFindingRows("generated/0296_x.sql", "0296", [{ ...good, code: "0297.other_reason" }]),
    /does not start with this migration's ordinal 0296/,
  );
  assert.throws(
    () => validateFindingRows("generated/0296_x.sql", "0296", [{ ...good, severity: "warn" }]),
    /must be 'refuse' or 'notice'/,
  );
});

type RecordedCall = { text: string };
function fakeClient(behavior: (text: string) => unknown): { client: pg.PoolClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client = {
    query: async (text: string) => {
      calls.push({ text });
      return behavior(text);
    },
  } as unknown as pg.PoolClient;
  return { client, calls };
}

test("a non-SELECT preflight is refused before touching the database", () => {
  assert.throws(
    () => assertReadOnlyPreflight("generated/0296_x.sql", "-- prose\nupdate t set x = 1;"),
    /not a SELECT or WITH/,
  );
  assertReadOnlyPreflight("generated/0296_x.sql", "-- prose\nwith x as (select 1) select * from x;");
});

test("the evaluator runs BEGIN READ ONLY with a bounded timeout and always rolls back", async () => {
  const { client, calls } = fakeClient((text) =>
    text.startsWith("select") ? { rows: [] } : { rows: [] },
  );
  const result = await evaluatePreflight(client, "generated/0296_x.sql", "0296", "select 1", {
    statementTimeoutMs: 60_000,
  });
  assert.deepEqual(result, { status: "ready", findings: [], leastPrivilege: false });
  const texts = calls.map((call) => call.text);
  assert.ok(texts[0].toLowerCase().startsWith("begin"), texts[0]);
  assert.ok(texts[0].toLowerCase().includes("read only"), texts[0]);
  assert.ok(texts.some((text) => text === "set local statement_timeout = 60000"));
  assert.ok(texts.some((text) => text === "set local app.bypass_rls = 'on'"));
  assert.equal(texts.at(-1), "rollback");
});

test("a statement timeout still rolls back, and a missing object defers", async () => {
  const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  const failing = fakeClient((text) => {
    if (text.startsWith("select")) throw timeout;
    return { rows: [] };
  });
  await assert.rejects(
    () =>
      evaluatePreflight(failing.client, "generated/0296_x.sql", "0296", "select 1", {
        statementTimeoutMs: 60_000,
      }),
    /statement timeout/,
  );
  assert.equal(failing.calls.at(-1)?.text, "rollback");

  const missing = Object.assign(new Error('relation "later_table" does not exist'), { code: "42P01" });
  const deferring = fakeClient((text) => {
    if (text.startsWith("select")) throw missing;
    return { rows: [] };
  });
  const deferred = await evaluatePreflight(deferring.client, "generated/0300_x.sql", "0300", "select 1", {
    statementTimeoutMs: 60_000,
  });
  assert.equal(deferred.status, "deferred");
  assert.equal(deferring.calls.at(-1)?.text, "rollback");
});

test("the least-privilege role is proven when assumable and reported when not", async () => {
  const granted = fakeClient(() => ({ rows: [] }));
  const ok = await evaluatePreflight(granted.client, "generated/0296_x.sql", "0296", "select 1", {
    statementTimeoutMs: 60_000,
    leastPrivilegeRole: "openbooks_read",
  });
  assert.equal(ok.leastPrivilege, true);
  assert.ok(granted.calls.some((call) => call.text === "set local role openbooks_read"));

  const denied = Object.assign(new Error('permission denied to set role "openbooks_read"'), {
    code: "42501",
  });
  const missing = Object.assign(new Error('role "openbooks_read" does not exist'), {
    code: "22023",
  });
  const ungranted = fakeClient((text) => {
    if (text === "set local role openbooks_read") throw denied;
    return { rows: [] };
  });
  const norole = fakeClient((text) => {
    if (text === "set local role openbooks_read") throw missing;
    return { rows: [] };
  });
  const fallback = await evaluatePreflight(ungranted.client, "generated/0296_x.sql", "0296", "select 1", {
    statementTimeoutMs: 60_000,
    leastPrivilegeRole: "openbooks_read",
  });
  assert.equal(fallback.leastPrivilege, false);
  assert.equal(fallback.status, "ready");
  const noroleResult = await evaluatePreflight(norole.client, "generated/0296_x.sql", "0296", "select 1", {
    statementTimeoutMs: 60_000,
    leastPrivilegeRole: "openbooks_read",
  });
  assert.equal(noroleResult.leastPrivilege, false);
  assert.equal(noroleResult.status, "ready");

  await assert.rejects(() =>
    evaluatePreflight(granted.client, "generated/0296_x.sql", "0296", "select 1", {
      statementTimeoutMs: 60_000,
      leastPrivilegeRole: "evil;role",
    }),
  );
});

test("a refused least-privilege role does not poison the transaction", async () => {
  // A real PostgreSQL aborts the whole transaction on the failed SET ROLE;
  // every later statement then fails with "current transaction is aborted"
  // until a (sub)rollback. The evaluator must recover via savepoint, not
  // carry the poison into the preflight SELECT.
  const calls: string[] = [];
  let aborted = false;
  const missing = Object.assign(new Error('role "openbooks_read" does not exist'), { code: "22023" });
  const abortError = () => new Error("current transaction is aborted, commands ignored until end of transaction block");
  const client = {
    query: async (text: string) => {
      calls.push(text);
      if (text === "rollback" || text.startsWith("rollback to savepoint")) {
        aborted = false;
        return { rows: [] };
      }
      if (aborted) throw abortError();
      if (text === "set local role openbooks_read") {
        aborted = true;
        throw missing;
      }
      return { rows: [] };
    },
  } as unknown as pg.PoolClient;
  const result = await evaluatePreflight(client, "generated/0296_x.sql", "0296", "select 1", {
    statementTimeoutMs: 60_000,
    leastPrivilegeRole: "openbooks_read",
  });
  assert.deepEqual(result, { status: "ready", findings: [], leastPrivilege: false });
  assert.ok(calls.includes("rollback to savepoint preflight_least_privilege"));
  assert.equal(calls.at(-1), "rollback");
});

test("findings print with code, severity, subject, detail, and remedy", () => {
  const text = formatFinding({
    migration: "generated/0296_x.sql",
    code: "0296.malformed_remittance_marker",
    severity: "refuse",
    subject: "stub 1",
    detail: "bad marker",
    remedy: "fix it",
  });
  for (const part of ["refuse", "0296.malformed_remittance_marker", "stub 1", "bad marker", "fix it"]) {
    assert.ok(text.includes(part), part);
  }
});
