import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

const stateKey = Symbol.for("openbooks.expense-create-scope-test");
interface Gate {
  user: { orgId: string; id: string };
  permissions: Set<string>;
  allowedSubsidiaryIds: Set<string> | null;
}
const routeState: { gate: Gate | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const module_ = (source: string): { shortCircuit: true; format: "module"; url: string } => ({
  shortCircuit: true,
  format: "module",
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Re-export the REAL authz module and override only the session gate, so
    // the scope the create route resolves is the production resolution.
    // The route gates through guardFeaturePermission, which calls the REAL
    // guardPermission via web/lib's own './authz' specifier — intercept that
    // too, or the feature gate would resolve a real session.
    if (
      specifier === "../../../../lib/authz" ||
      (specifier === "./authz" && (context.parentURL ?? "").includes("/web/lib/"))
    ) {
      const real = nextResolve(specifier, context).url;
      const nextServer = nextResolve("next/server", context).url;
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.expense-create-scope-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(_permission) {
          if (!state.gate) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          return state.gate;
        }
      `);
    }
    return nextResolve(specifier, context);
  },
});

const { withBypassContext, db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { POST } = await import("./route.ts");
// The factory's lazy feature-gate import runs on every request, so the hook
// must stay registered until the file's tests finish.
test.after(() => hooks.deregister());

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() =>
    createScratchUser(org.orgId, "Expense drafter", "reviewer"),
  );
  const other = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA')
  `),
  );
  const gate = (scope: Set<string> | null) => {
    routeState.gate = {
      user: { orgId: org.orgId, id: actor },
      permissions: new Set(["expenses.create"]),
      allowedSubsidiaryIds: scope,
    };
  };
  return { org, other, gate };
}

async function expenseReports(orgId: string) {
  return await db.execute<{ id: string; subsidiary_id: string | null; document_number: string }>(
    sql`
    select id, subsidiary_id, document_number from documents
     where org_id = ${orgId} and kind = 'expense_report'
  `,
    "objects",
  );
}

function createRequest(key: string, body: Record<string, unknown>): Request {
  return new Request("http://openbooks.test/api/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

function lineBody(accountId: string): Record<string, unknown> {
  return {
    documentDate: "2026-10-01",
    lines: [{ accountId, description: "Taxi", amount: "25", settlementType: "out_of_pocket" }],
  };
}

test("a restricted expense report is created in their own subsidiary", async () => {
  const { org, gate } = await setup();
  try {
    gate(new Set([org.subsidiaryId]));
    const res = await POST(createRequest(randomUUID(), lineBody(org.accounts.cogs)));
    assert.equal(res.status, 201);
    const created = (await res.json()) as { doc: { id: string } };
    const reports = await expenseReports(org.orgId);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.id, created.doc.id);
    assert.equal(reports[0]!.subsidiary_id, org.subsidiaryId);
    assert.match(reports[0]!.document_number, /^EXP-/);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("an expense report with no assignable subsidiary refuses by name and stores nothing", async () => {
  const { org, other, gate } = await setup();
  try {
    gate(new Set([org.subsidiaryId, other]));
    const res = await POST(createRequest(randomUUID(), lineBody(org.accounts.cogs)));
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "subsidiary_required" });
    assert.deepEqual(await expenseReports(org.orgId), []);
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("an untouched Save refuses without numbering, and a replayed Save returns the one report", async () => {
  const { org, gate } = await setup();
  try {
    gate(null);
    const blankKey = randomUUID();
    const blank = await POST(createRequest(blankKey, { documentDate: "2026-10-01", lines: [] }));
    assert.equal(blank.status, 422);
    assert.deepEqual(await expenseReports(org.orgId), []);

    const key = randomUUID();
    const first = await POST(createRequest(key, lineBody(org.accounts.cogs)));
    assert.equal(first.status, 201);
    const replay = await POST(createRequest(key, lineBody(org.accounts.cogs)));
    assert.equal(replay.status, 200);
    const reports = await expenseReports(org.orgId);
    assert.equal(reports.length, 1, "a retried Save must not number a second report");
    const conflict = await POST(createRequest(key, lineBody(org.accounts.freight)));
    assert.equal(conflict.status, 409, "the same key with a different body must refuse");
  } finally {
    routeState.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
