import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Client } from "pg";

// Live-Postgres regression for fnd_mt9gtqwq_wtnaf0: the recipient PATCH route
// used to read the filing status OUTSIDE any transaction and then UPDATE the
// recipient row with an unguarded WHERE (`where org_id = … and id = …`), so a
// finalize committing between its read and its write still mutated frozen
// evidence even after the engine service had been hardened. The route now
// delegates every mutation to `updateFilingRecipient` — the engine's one
// guarded path — and these tests prove against the REAL ROUTE that an edit
// racing a freeze can never land on frozen storage, that voiding a FILED
// return through the action route is refused, and (statically, always-on)
// that no module outside the engine service can reach either table with a
// write at all.

const stateKey = Symbol.for("openbooks.ir-recipient-route-test");
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
  const state = globalThis[Symbol.for('openbooks.ir-recipient-route-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export async function getAuthz() {
    return state.authz
  }
  export function can(_authz, permission) {
    return state.authz?.permissions?.has(permission) ?? false
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The server-only marker gates RSC bundling; shim it so server modules
    // load under the plain runner (same seam as the navigation route test).
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Both routes of this surface share the authz seam; guardPermission and
    // getAuthz/can are stubbed together.
    if (specifier === "@/lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    // Forward Next.js-style aliases to the real modules they point at,
    // computing each importer's own web root (routes live at several depths).
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
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

const routeUrl = "./route.ts?ir-recipient-freeze-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
const postRouteUrl = "../../route.ts?ir-filing-action-test";
const { POST } = (await import(postRouteUrl)) as typeof import("../../route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const {
  ensureFiling,
  finalizeFiling,
  markFilingFiled,
} = await import("@openbooks/engine/src/information-returns.ts");
const { createScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Seed a `computed` 1099-NEC filing with two included recipients (TINs on file). */
async function seedComputedFiling(
  orgId: string,
  actorId: string,
  taxYear: number,
): Promise<{ filingId: string; recipientIds: string[] }> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
      '{features,subcontractorCompliance}', 'true'::jsonb, true)
     where id = ${orgId}`);
  const filing = await ensureFiling({ orgId, taxYear, formType: "1099-NEC", currency: "USD", actorId });
  const recipientIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const partyId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${partyId}, ${orgId}, 'vendor', ${`Recipient ${taxYear}-${i}`},
              null, true, '{}'::jsonb)`);
    const recipientId = randomUUID();
    await db.execute(sql`
      insert into information_return_recipients
        (id, org_id, filing_id, party_id, computed_amounts, status, tin_last4, tin_type,
         created_by, updated_by)
      values (${recipientId}, ${orgId}, ${filing.id}, ${partyId},
              ${JSON.stringify({ nec1: `${1000 + i}.0000` })}::jsonb,
              'included', ${i === 0 ? "1234" : "5678"}, 'ein', ${actorId}, ${actorId})`);
    recipientIds.push(recipientId);
  }
  await db.execute(sql`
    update information_return_filings
       set status = 'computed', computed_at = now(), computed_by = ${actorId}
     where id = ${filing.id}`);
  return { filingId: filing.id, recipientIds };
}

type RecipientRow = {
  status: string;
  adjustments: Record<string, string>;
  exclusion_reason: string | null;
  updated_at: Date;
};

async function recipientRow(
  orgId: string,
  recipientId: string,
): Promise<RecipientRow> {
  const r = await db.execute<{ status: string; adjustments: Record<string, string>; exclusion_reason: string | null; updated_at: Date | string }>(sql`
    select status, adjustments, exclusion_reason, updated_at
      from information_return_recipients
     where org_id = ${orgId} and id = ${recipientId}`);
  const row = r.rows[0]!;
  // Raw drizzle SQL hands timestamptz back as a string.
  return { ...row, updated_at: new Date(row.updated_at as unknown as string) };
}

async function filingStatus(orgId: string, filingId: string): Promise<string> {
  const r = await db.execute<{ status: string }>(sql`
    select status from information_return_filings where org_id = ${orgId} and id = ${filingId}`);
  return r.rows[0]!.status;
}

async function recipientAuditCount(orgId: string, recipientId: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name = 'information_return_recipients'
       and row_id = ${recipientId}`);
  return r.rows[0]!.n;
}

async function filingAudits(orgId: string, filingId: string): Promise<string[]> {
  const r = await db.execute<{ action: string }>(sql`
    select action from audit_log
     where org_id = ${orgId} and table_name = 'information_return_filings' and row_id = ${filingId}
     order by at, id`);
  return r.rows.map((row) => row.action);
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/compliance/information-returns/x/recipients/y", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/compliance/information-returns/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A committed-outside-the-service freeze used to force the exact interleaving
 * that used to corrupt evidence: the holder pins the filing row itself, the
 * route's mutation attempt is provably blocked against that pin, and the
 * freeze then commits out from under it. The hardened path serializes here —
 * it is BLOCKED at its `for update` when the barrier fires — so the freeze is
 * always already committed before it may validate; the old unguarded route
 * never synchronized with the freeze at all.
 */
async function holdFilingLock(orgId: string, filingId: string): Promise<Client> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  await client.connect();
  await client.query("begin");
  await client.query(
    "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
    [orgId],
  );
  await client.query(
    "select id from information_return_filings where org_id = $1 and id = $2 for update",
    [orgId, filingId],
  );
  return client;
}

/**
 * Deterministic barrier: wait until the in-flight PATCH is provably blocked
 * on a lock while touching an information-return table. The hardened path
 * blocks at its `for update` of the filing row before validating anything.
 */
async function waitForRouteBlockedOnFilingRow(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const r = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query ilike '%information_return%'`);
    if ((r.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "the PATCH never synchronized with the pinned filing row — it mutated (or validated) outside any lock with the freeze",
  );
}

test("PATCH through the real route persists signed deltas and audits them once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    routeState.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(), allowedSubsidiaryIds: null };
    const { filingId, recipientIds } = await seedComputedFiling(org.orgId, actorId, 2061);
    const target = recipientIds[0]!;

    const res = await PATCH(patchRequest({ adjustments: { nec1: "-250.5" }, adjustmentReason: "duplicate cheque recovered" }), {
      params: Promise.resolve({ id: filingId, recipientId: target }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: target });

    const row = await recipientRow(org.orgId, target);
    assert.deepEqual(row.adjustments, { nec1: "-250.5000" });
    assert.equal(row.status, "included");
    assert.equal(await recipientAuditCount(org.orgId, target), 1);

    // Malformed input fails closed at the boundary without writing evidence.
    const badBox = await PATCH(patchRequest({ adjustments: { nec99: "5" }, adjustmentReason: "x" }), {
      params: Promise.resolve({ id: filingId, recipientId: target }),
    });
    assert.equal(badBox.status, 400);
    const noReason = await PATCH(patchRequest({ status: "excluded" }), {
      params: Promise.resolve({ id: filingId, recipientId: target }),
    });
    assert.equal(noReason.status, 400);
    const missing = await PATCH(patchRequest({ status: "excluded", exclusionReason: "x" }), {
      params: Promise.resolve({ id: filingId, recipientId: randomUUID() }),
    });
    assert.equal(missing.status, 404);
    assert.equal(await recipientAuditCount(org.orgId, target), 1);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReportingSafe(org.orgId);
  }
});

test("the finalize-versus-PATCH race cannot mutate frozen evidence through the real route", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let holder: Client | null = null;
  try {
    const actorId = randomUUID();
    routeState.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(), allowedSubsidiaryIds: null };
    const { filingId, recipientIds } = await seedComputedFiling(org.orgId, actorId, 2062);
    const target = recipientIds[0]!;
    const before = await recipientRow(org.orgId, target);

    // Pin the filing row, START the route's edit, wait until it is provably
    // blocked against that pin, then freeze inside the holder and commit. The
    // hardened path is queued on its `for update` here, so the freeze is
    // always committed before it may validate — it must refuse; a route that
    // never synchronized (the old unguarded one) fails the barrier instead.
    holder = await holdFilingLock(org.orgId, filingId);
    const patchPromise = PATCH(patchRequest({ adjustments: { nec1: "-100" }, adjustmentReason: "late refund" }), {
      params: Promise.resolve({ id: filingId, recipientId: target }),
    }).then(async (res) => ({ status: res.status, body: (await res.json()) as { error?: string } }));
    await waitForRouteBlockedOnFilingRow();
    await holder.query(
      `update information_return_filings
          set status = 'finalized', finalized_at = now(), finalized_by = $1,
              payer_snapshot = $2::jsonb
        where org_id = $3 and id = $4`,
      [
        actorId,
        JSON.stringify({ name: "Test Payer", orgName: "Test Org", taxIds: {}, taxYear: 2062, formType: "1099-NEC", threshold: "600", currency: "USD" }),
        org.orgId,
        filingId,
      ],
    );
    await holder.query("commit");
    await holder.end();
    holder = null;

    const result = await patchPromise;
    assert.equal(result.status, 422);
    assert.match(result.body.error ?? "", /frozen/);

    // Frozen storage untouched: no shadow write, not even an updated_at bump.
    const after = await recipientRow(org.orgId, target);
    assert.deepEqual(
      { ...after, updated_at: undefined },
      { ...before, updated_at: undefined },
    );
    assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
    assert.deepEqual(after.adjustments, {});
    assert.equal(await recipientAuditCount(org.orgId, target), 0);
    // The simulated freeze bypassed the service on purpose; the assertion that
    // matters is that the refused edit added nothing to the audit trail.
    assert.deepEqual(await filingAudits(org.orgId, filingId), []);
  } finally {
    routeState.authz = null;
    if (holder) {
      await holder.query("rollback").catch(() => {});
      await holder.end().catch(() => {});
    }
    await dropScratchOrgReportingSafe(org.orgId);
  }
});

test("when the edit wins the race its delta is part of the frozen evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    routeState.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(), allowedSubsidiaryIds: null };
    const { filingId, recipientIds } = await seedComputedFiling(org.orgId, actorId, 2063);
    const target = recipientIds[0]!;

    const [edit, freeze] = await Promise.allSettled([
      PATCH(patchRequest({ adjustments: { nec1: "-100" }, adjustmentReason: "refund issued after year end" }), {
        params: Promise.resolve({ id: filingId, recipientId: target }),
      }),
      finalizeFiling({ orgId: org.orgId, filingId, actorId }),
    ]);
    assert.equal(freeze.status, "fulfilled", "finalize must succeed either way");
    assert.ok(edit.status === "fulfilled", "the route returns responses; it must not reject");
    assert.equal(await filingStatus(org.orgId, filingId), "finalized");

    const row = await recipientRow(org.orgId, target);
    if (edit.value.status === 200) {
      // The edit committed before the freeze took the lock: legitimate.
      assert.deepEqual(row.adjustments, { nec1: "-100.0000" });
      assert.equal(await recipientAuditCount(org.orgId, target), 1);
    } else {
      // The freeze won: the route refused with zero effect.
      assert.equal(edit.value.status, 422);
      assert.deepEqual(row.adjustments, {});
      assert.equal(await recipientAuditCount(org.orgId, target), 0);
    }
  } finally {
    routeState.authz = null;
    await dropScratchOrgReportingSafe(org.orgId);
  }
});

test("the action route refuses to void a FILED return and writes exactly one void audit", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    routeState.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["compliance.manage", "compliance.file"]), allowedSubsidiaryIds: null };

    // A filed return is permanent evidence: the action route used to void it
    // with a bare UPDATE; through the service it is refused.
    const filed = await seedComputedFiling(org.orgId, actorId, 2064);
    await finalizeFiling({ orgId: org.orgId, filingId: filed.filingId, actorId });
    await markFilingFiled({ orgId: org.orgId, filingId: filed.filingId, channel: "paper", actorId });
    const refused = await POST(postRequest({ action: "void", reason: "superseded" }), {
      params: Promise.resolve({ id: filed.filingId }),
    });
    assert.equal(refused.status, 422);
    assert.match(((await refused.json()) as { error: string }).error, /permanent evidence/);
    assert.equal(await filingStatus(org.orgId, filed.filingId), "filed");

    // Voiding before transmission works, through the service, with exactly one
    // atomic audit row.
    const unfrozen = await seedComputedFiling(org.orgId, actorId, 2065);
    const ok = await POST(postRequest({ action: "void", reason: "superseded by corrected return" }), {
      params: Promise.resolve({ id: unfrozen.filingId }),
    });
    assert.equal(ok.status, 200);
    assert.equal(await filingStatus(org.orgId, unfrozen.filingId), "void");
    assert.deepEqual(await filingAudits(org.orgId, unfrozen.filingId), ["void"]);

    // Unknown filing ids fail closed as 404.
    const missing = await POST(postRequest({ action: "void", reason: "x" }), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    assert.equal(missing.status, 404);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReportingSafe(org.orgId);
  }
});

test("no caller outside the engine service can reach the information-return tables with a write", async () => {
  // Static proof for "every mutation routes through the one guarded path":
  // any INSERT INTO / UPDATE / DELETE FROM against information_return_filings
  // or information_return_recipients must live in the owning engine module.
  // Test files seed fixtures directly and are exempt; production code is not.
  const owner = "engine/src/information-returns.ts";
  const forbidden =
    /\b(?:insert\s+into|update|delete\s+from)\s+information_return_(?:filings|recipients)\b/i;
  const root = fileURLToPath(new URL("../../../../../../../../", import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", ".next", "dist", ".turbo"].includes(entry.name)) continue;
      const full = `${dir}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
      const rel = full.slice(root.length);
      if (rel === owner) continue;
      if (forbidden.test(readFileSync(full, "utf8"))) offenders.push(rel);
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

/** Teardown failures must not replace an in-flight assertion error. */
async function dropScratchOrgReportingSafe(orgId: string): Promise<void> {
  const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
  await dropScratchOrgReporting(orgId);
}
