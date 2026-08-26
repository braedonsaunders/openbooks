import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";

// Regression for the tax-rate domain contract (web/app/api/admin/setup/[entity]/route.ts).
// Setup used to persist negative and FX-scale tax rates that the calculation
// engine (engine/src/tax.ts) refuses at every later document, and its
// autocommit natural-key duplicate check let two concurrent creates commit
// parallel authoritative definitions. These tests pin the API rejection, the
// storage CHECK/UNIQUE authority (migration 0042), the deterministic 409
// mapping, audit atomicity, and the exact-decimal effective-dated happy path.
const stateKey = Symbol.for("openbooks.tax-rate-domain-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.tax-rate-domain-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as setup-route-contract.test.ts).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Forward Next.js-style aliases to the real modules they point at.
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    const entityRoute = context.parentURL?.includes("%5Bentity%5D")
      ?? context.parentURL?.includes("[entity]");
    if (specifier === "../../../../../lib/authz" && entityRoute) {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?tax-rate-domain-route-test";
const { PATCH, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { computeLineTaxes } = await import("@openbooks/engine/src/tax.ts");
const { loadTaxComponentConfig } = await import("@openbooks/engine/src/tax-persist.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function authenticate(f: { orgId: string; actorId: string }) {
  routeState.authz = {
    user: { orgId: f.orgId, id: f.actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

function postRequest(entity: string, body: unknown): Request {
  return new Request(`http://localhost/api/admin/setup/${entity}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function patchRequest(entity: string, body: unknown): Request {
  return new Request(`http://localhost/api/admin/setup/${entity}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const call = (entity: string, body: unknown) => ({ params: Promise.resolve({ entity }) });

interface TaxFixture {
  orgId: string;
  actorId: string;
  vatCodeId: string;
}

async function seedTaxFixture(): Promise<TaxFixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Tax Setup Admin", "admin");
  authenticate({ orgId: org.orgId, actorId });
  const res = await POST(
    postRequest("tax-codes", { code: "OB-VAT", name: "VAT", isActive: true }),
    call("tax-codes", {}),
  );
  assert.equal(res.status, 200);
  const { id } = (await res.json()) as { id: string };
  return { orgId: org.orgId, actorId, vatCodeId: id };
}

async function taxRateRows(orgId: string): Promise<{ id: string; rate: string }[]> {
  const result = await db.execute<{ id: string; rate: string }>(sql`
    select id, rate_percent::text as rate from tax_rates where org_id = ${orgId} order by effective_from`);
  return result.rows;
}

async function auditCount(orgId: string, table: string, rowId?: string): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = ${table}
       ${rowId ? sql`and row_id = ${rowId}` : sql``}`);
  return result.rows[0]!.n;
}

test("the setup route states the tax-rate domain before every write and maps storage duplicates to 409", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /entity\.key === 'tax-rates'/);
  assert.match(source, /taxRatePercentProblem\(raw\)/);
  // The domain check rides validateEntityIntegrity, which must run before the
  // create and update transactions alike.
  const postValidation = source.indexOf("const integrityError = await validateEntityIntegrity");
  const postWrite = source.indexOf("const newId = await db.transaction");
  const patchValidation = source.lastIndexOf("const integrityError = await validateEntityIntegrity");
  const patchWrite = source.indexOf("const found = await db.transaction");
  assert.ok(postValidation >= 0 && postValidation < postWrite, "create validation must precede the write");
  assert.ok(
    patchValidation > postWrite && patchValidation < patchWrite,
    "update validation must precede the write",
  );
  // Storage is the duplicate authority for every writer: a natural-key race
  // surfaces as a deterministic 409 on both the create and update paths, with
  // the driver SQLSTATE read through Drizzle's error wrapper.
  assert.equal(source.match(/pgErrorCode\(e\) === '23505'/g)?.length, 2);
});

test("API rejects negative and out-of-domain tax rates before any write", { skip: !DB }, async () => {
  const f = await seedTaxFixture();
  try {
    const beforeRates = await taxRateRows(f.orgId);
    const beforeAudits = await auditCount(f.orgId, "tax_rates");

    for (const [label, override] of [
      ["negative", { ratePercent: "-13" }],
      ["negative-sub-cent", { ratePercent: "-0.0001" }],
      ["fx-scale-precision", { ratePercent: "13.00005" }],
    ] as const) {
      const res = await POST(
        postRequest("tax-rates", {
          taxCodeId: f.vatCodeId,
          effectiveFrom: "2026-01-01",
          ...override,
        }),
        call("tax-rates", {}),
      );
      assert.equal(res.status, 400, `${label}: expected a client error`);
      const body = (await res.json()) as { error: string };
      assert.ok(
        body.error === "negative-tax-rate" || body.error === "invalid-tax-rate"
          || /ratePercent/.test(body.error),
        `${label}: unexpected error "${body.error}"`,
      );
    }
    // Values the shared coercer already refuses stay refused.
    for (const [label, override] of [
      ["not-a-decimal", { ratePercent: "thirteen" }],
      ["missing-rate", {}],
    ] as const) {
      const res = await POST(
        postRequest("tax-rates", { taxCodeId: f.vatCodeId, effectiveFrom: "2026-01-01", ...override }),
        call("tax-rates", {}),
      );
      assert.equal(res.status, 400, `${label}: expected a client error`);
    }
    assert.deepEqual(await taxRateRows(f.orgId), beforeRates, "no rate row was written");
    assert.equal(await auditCount(f.orgId, "tax_rates"), beforeAudits, "no orphan audit was written");

    // A valid exact-decimal rate persists, then refuses edits that leave the
    // domain. (The PATCH contract carries the full record, like the drawer.)
    const created = await POST(
      postRequest("tax-rates", {
        taxCodeId: f.vatCodeId,
        ratePercent: "8.875",
        effectiveFrom: "2026-01-01",
      }),
      call("tax-rates", {}),
    );
    assert.equal(created.status, 200);
    const { id } = (await created.json()) as { id: string };
    assert.equal(await auditCount(f.orgId, "tax_rates", id), 1);

    for (const [label, override] of [
      ["negative", { ratePercent: "-5" }],
      ["fx-scale-precision", { ratePercent: "8.87505" }],
    ] as const) {
      const rejected = await PATCH(
        patchRequest("tax-rates", {
          id,
          taxCodeId: f.vatCodeId,
          effectiveFrom: "2026-01-01",
          ...override,
        }),
        call("tax-rates", {}),
      );
      assert.equal(rejected.status, 400, `${label}: edit must be refused`);
      const body = (await rejected.json()) as { error: string };
      assert.ok(
        body.error === "negative-tax-rate" || body.error === "invalid-tax-rate",
        `${label}: unexpected error "${body.error}"`,
      );
    }
    // The refused edits left the stored value untouched, and a valid edit
    // keeps the effective rate intact while closing its window.
    const edited = await PATCH(
      patchRequest("tax-rates", {
        id,
        taxCodeId: f.vatCodeId,
        ratePercent: "8.875",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-06-30",
      }),
      call("tax-rates", {}),
    );
    assert.equal(edited.status, 200);
    const rows = await taxRateRows(f.orgId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.rate, "8.8750");
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("valid exact-decimal effective-dated rates persist and calculate", { skip: !DB }, async () => {
  const f = await seedTaxFixture();
  try {
    // A statutory zero rate on a lapsed window and an exact 4-decimal rate on
    // the open window: both are legitimate configuration and must save.
    const zero = await POST(
      postRequest("tax-rates", {
        taxCodeId: f.vatCodeId,
        ratePercent: "0",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-06-30",
      }),
      call("tax-rates", {}),
    );
    assert.equal(zero.status, 200);
    const standard = await POST(
      postRequest("tax-rates", {
        taxCodeId: f.vatCodeId,
        ratePercent: "8.875",
        effectiveFrom: "2026-07-01",
      }),
      call("tax-rates", {}),
    );
    assert.equal(standard.status, 200);
    assert.deepEqual(await taxRateRows(f.orgId), [
      { id: (await zero.json()).id, rate: "0.0000" },
      { id: (await standard.json()).id, rate: "8.8750" },
    ]);

    // The engine resolves the effective rate for the document date and
    // calculates with it exactly — the same contract the API validates.
    const early = await loadTaxComponentConfig(f.orgId, f.vatCodeId, "2026-03-01");
    assert.equal(early[0]!.ratePercent, "0.0000");
    const zeroTax = computeLineTaxes("100.0000", early);
    assert.equal(zeroTax.taxTotal, "0.0000");
    assert.equal(zeroTax.total, "100.0000");

    const late = await loadTaxComponentConfig(f.orgId, f.vatCodeId, "2026-08-01");
    assert.equal(late[0]!.ratePercent, "8.8750");
    const calculated = computeLineTaxes("100.0000", late);
    assert.equal(calculated.components[0]!.ratePercent, "8.8750");
    assert.equal(calculated.components[0]!.taxAmount, "8.8800");
    assert.equal(calculated.taxTotal, "8.8800");
    assert.equal(calculated.total, "108.8800");

    // A date before any effective window fails closed, naming code and date —
    // it never silently computes at 0%.
    await assert.rejects(
      loadTaxComponentConfig(f.orgId, f.vatCodeId, "2025-12-31"),
      (e: unknown) => e instanceof Error && /OB-VAT.*no rate effective on 2025-12-31/.test(e.message),
    );
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(f.orgId);
  }
});

test("direct writes cannot persist negative tax rates: storage fails closed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Migration 0042 must have applied its full constraint set.
    const constraints = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint
       where conname in ('tax_rates_rate_percent_domain', 'tax_codes_org_code_unique',
                         'tax_groups_org_code_unique', 'classes_org_code_unique',
                         'departments_org_code_unique', 'locations_org_code_unique',
                         'worker_comp_groups_org_code_unique')`);
    assert.equal(constraints.rows.length, 7, "every 0042 constraint exists in the live catalog");

    const codeId = randomUUID();
    await db.execute(sql`
      insert into tax_codes (id, org_id, code, name)
      values (${codeId}, ${org.orgId}, 'DIRECT', 'Direct write')`);
    // Drizzle wraps the driver error (DrizzleQueryError.cause); match either.
    const isCheckViolation = (name: string) => (e: unknown) => {
      const error = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
      return (error?.code ?? error?.cause?.code) === "23514"
        && (error?.constraint ?? error?.cause?.constraint) === name;
    };
    await assert.rejects(
      db.execute(sql`
        insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from)
        values (${org.orgId}, ${codeId}, '-1.2500', '2026-01-01')`),
      isCheckViolation("tax_rates_rate_percent_domain"),
      "a negative rate must be unrepresentable",
    );
    // The statutory zero rate remains representable.
    await db.execute(sql`
      insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from)
      values (${org.orgId}, ${codeId}, '0.0000', '2026-01-01')`);
    await assert.rejects(
      db.execute(sql`
        update tax_rates set rate_percent = '-0.0001' where org_id = ${org.orgId}`),
      isCheckViolation("tax_rates_rate_percent_domain"),
      "an update to a negative rate must be unrepresentable",
    );
    const stored = await db.execute<{ rate: string }>(sql`
      select rate_percent::text as rate from tax_rates where org_id = ${org.orgId}`);
    assert.deepEqual(stored.rows, [{ rate: "0.0000" }]);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("two concurrent Setup creates cannot duplicate an authoritative code", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Setup Race Admin", "admin");
  try {
    authenticate({ orgId: org.orgId, actorId });
    const code = `RACE-${randomUUID().slice(0, 8)}`;
    const [first, second] = await Promise.all([
      POST(postRequest("tax-codes", { code, name: "Racer A" }), call("tax-codes", {})),
      POST(postRequest("tax-codes", { code, name: "Racer B" }), call("tax-codes", {})),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one create wins with a deterministic conflict");
    const conflict = first.status === 409 ? first : second;
    assert.deepEqual(await conflict.json(), { error: "duplicate", code: "duplicate" });

    const rows = await db.execute<{ id: string; n: number }>(sql`
      select id, count(*) over ()::int as n from tax_codes
       where org_id = ${org.orgId} and code = ${code}`);
    assert.equal(rows.rows[0]!.n, 1, "storage holds exactly one authoritative code");
    // The insert and its audit share one transaction: the losing request
    // leaves no row and no orphan audit evidence.
    assert.equal(await auditCount(org.orgId, "tax_codes", rows.rows[0]!.id), 1);
    assert.equal(await auditCount(org.orgId, "tax_codes"), 1);

    // An edit that moves a row onto an occupied natural key has no preflight
    // read: the storage constraint itself must surface as the same 409, with
    // the SQLSTATE read through Drizzle's error wrapper.
    const firstClass = await POST(
      postRequest("classes", { code: "RACE-CLS-A", name: "Class A" }),
      call("classes", {}),
    );
    assert.equal(firstClass.status, 200);
    const secondClass = await POST(
      postRequest("classes", { code: "RACE-CLS-B", name: "Class B" }),
      call("classes", {}),
    );
    assert.equal(secondClass.status, 200);
    const takeover = await PATCH(
      patchRequest("classes", {
        id: (await secondClass.json()).id,
        code: "RACE-CLS-A",
        name: "Class B",
      }),
      call("classes", {}),
    );
    assert.equal(takeover.status, 409);
    assert.deepEqual(await takeover.json(), { error: "duplicate", code: "duplicate" });
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(org.orgId);
  }
});

test("storage decides two-session create/create races for every authoritative setup table", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    for (const table of [
      "tax_codes",
      "tax_groups",
      "classes",
      "departments",
      "locations",
      "worker_comp_groups",
    ]) {
      const code = `RACE-${table}`.toUpperCase();
      const a = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
      const b = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL });
      await a.connect();
      await b.connect();
      try {
        for (const session of [a, b]) {
          await session.query("select set_config('app.current_org', $1, false)", [org.orgId]);
        }
        await a.query("begin");
        await b.query("begin");
        // Both sessions pass the exact read the Setup route used to trust.
        for (const [label, session] of [["A", a], ["B", b]] as const) {
          const sighted = await session.query(
            `select 1 from ${table} where org_id = $1 and code = $2`,
            [org.orgId, code],
          );
          assert.deepEqual(sighted.rows, [], `${table}: session ${label} saw no existing row`);
        }
        await a.query(
          `insert into ${table} (org_id, code, name) values ($1, $2, $3)`,
          [org.orgId, code, `Race ${table} A`],
        );
        // Session B's insert blocks on A's uncommitted unique index entry, so
        // A must commit first — the constraint then decides B's fate.
        const secondInsert = b.query(
          `insert into ${table} (org_id, code, name) values ($1, $2, $3)`,
          [org.orgId, code, `Race ${table} B`],
        );
        await a.query("commit");
        await assert.rejects(
          secondInsert,
          (e: unknown) =>
            (e as { code?: string }).code === "23505"
            && (e as { constraint?: string }).constraint === `${table}_org_code_unique`,
          `${table}: the second session must lose to storage`,
        );
        await b.query("rollback");
        const stored = await db.execute<{ n: number }>(sql`
          select count(*)::int as n from ${sql.raw(table)}
           where org_id = ${org.orgId} and code = ${code}`);
        assert.equal(stored.rows[0]!.n, 1, `${table}: exactly one authoritative row`);
      } finally {
        await a.end().catch(() => {});
        await b.end().catch(() => {});
      }
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
