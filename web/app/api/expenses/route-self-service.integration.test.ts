import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Expense self-service: a holder of expenses.self lists, reads, creates,
// edits, scans receipts on and submits only the reports whose employee is the
// person linked to their login. Another employee's report is
// indistinguishable from a missing one. Org-wide grants are unaffected.
const stateKey = Symbol.for("openbooks.expense-self-service-test");
interface Gate {
  user: { orgId: string; id: string; roles: { key: string }[]; isSuperAdmin: boolean };
  permissions: Set<string>;
  allowedSubsidiaryIds: Set<string> | null;
}
const routeState: { gate: Gate | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const virtual = (source: string) => ({
  shortCircuit: true as const,
  format: "module" as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    // Re-export the REAL authz module and override only the session: every
    // permission decision below is the production resolution over the gate.
    if (
      resolved.url.endsWith("/web/lib/authz.ts") &&
      !(context.parentURL ?? "").startsWith("data:")
    ) {
      const nextServer = nextResolve("next/server", context).url;
      return virtual(`
        export * from ${JSON.stringify(resolved.url)};
        import { can } from ${JSON.stringify(resolved.url)};
        const state = globalThis[Symbol.for('openbooks.expense-self-service-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function getAuthz() { return state.gate }
        export async function guardPermission(permission) {
          if (!state.gate) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          if (!can(state.gate, permission)) return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
          return state.gate;
        }
      `);
    }
    return resolved;
  },
});

const { withBypassContext, db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { POST: createReport } = await import("./route.ts");
const reportRoute = await import("./[id]/route.ts");
const receiptsRoute = await import("./[id]/receipts/route.ts");
const { POST: action } = await import("./actions/route.ts");
const { expenseListOwnerFilter } = await import("../../../lib/expense-access");
const { canReadSubjectRecord } = await import("../../../lib/flow-subject-authz");
const { globalSearch } = await import("../../../lib/search");
test.after(() => hooks.deregister());

type Fixture = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  const employee = randomUUID();
  const coworker = randomUUID();
  const actor = await withBypassContext(() =>
    createScratchUser(org.orgId, "Riley Fieldworker", "field_employee"),
  );
  const reviewer = await withBypassContext(() =>
    createScratchUser(org.orgId, "Expense reviewer", "expense_reviewer"),
  );
  const unlinked = await withBypassContext(() =>
    createScratchUser(org.orgId, "Unlinked login", "unlinked_employee"),
  );
  const ownReport = randomUUID();
  const otherReport = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employee}, ${org.orgId}, 'employee', 'Riley Fieldworker', true, '{}'::jsonb),
             (${coworker}, ${org.orgId}, 'employee', 'Sam Coworker', true, '{}'::jsonb)`);
    await db.execute(
      sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employee}), (${randomUUID()}, ${org.orgId}, ${coworker})`,
    );
    await db.execute(
      sql`update users set party_id = ${employee} where id = ${actor} and org_id = ${org.orgId}`,
    );
    await db.execute(
      sql`update app_roles set permissions = '["expenses.self"]'::jsonb where org_id = ${org.orgId} and key in ('field_employee', 'unlinked_employee')`,
    );
    await db.execute(
      sql`update app_roles set permissions = '["expenses.read", "expenses.create"]'::jsonb where org_id = ${org.orgId} and key = 'expense_reviewer'`,
    );
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values (${ownReport}, ${org.orgId}, 'expense_report', 'draft', 'EXP-SELF-1', ${org.date}, ${employee}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb),
             (${otherReport}, ${org.orgId}, 'expense_report', 'draft', 'EXP-SELF-2', ${org.date}, ${coworker}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`);
  });
  const as = (userId: string, permissions: string[]) => {
    routeState.gate = {
      user: { orgId: org.orgId, id: userId, roles: [], isSuperAdmin: false },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    };
    // The gate carries the session fields the routes read; the record-level
    // grant helpers take it as their authority.
    return routeState.gate as unknown as Parameters<typeof canReadSubjectRecord>[0];
  };
  return { org, employee, coworker, actor, reviewer, unlinked, ownReport, otherReport, as };
}

async function teardown(fixture: Fixture) {
  routeState.gate = null;
  await withBypassContext(async () => {
    await db.execute(sql`update users set party_id = null where org_id = ${fixture.org.orgId}`);
    await db.execute(sql`delete from employee_roles where org_id = ${fixture.org.orgId}`);
  });
  await withBypassContext(() => dropScratchOrg(fixture.org.orgId));
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonRequest = (
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`http://openbooks.test${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const taxiLine = (fixture: Fixture) => [
  {
    accountId: fixture.org.accounts.cogs,
    description: "Taxi",
    amount: "25",
    settlementType: "out_of_pocket",
  },
];

async function revision(id: string): Promise<string> {
  const res = await reportRoute.GET(jsonRequest(`/api/expenses/${id}`, "GET"), params(id));
  assert.equal(res.status, 200);
  return String(((await res.json()) as { doc: { updated_at: string } }).doc.updated_at);
}

async function reportsOf(orgId: string) {
  return withBypassContext(
    async () =>
      await db.execute<{ id: string; party_id: string | null }>(
        sql`
    select id, party_id from documents where org_id = ${orgId} and kind = 'expense_report' order by document_number`,
        "objects",
      ),
  );
}

test("an expense self-service holder reads, edits, scans and submits only their own reports", async () => {
  const fixture = await setup();
  try {
    fixture.as(fixture.actor, ["expenses.self"]);
    assert.equal(
      (
        await reportRoute.GET(
          jsonRequest(`/api/expenses/${fixture.ownReport}`, "GET"),
          params(fixture.ownReport),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await reportRoute.GET(
          jsonRequest(`/api/expenses/${fixture.otherReport}`, "GET"),
          params(fixture.otherReport),
        )
      ).status,
      404,
      "a coworker's report reads as missing",
    );

    const ownRevision = await revision(fixture.ownReport);
    const saved = await reportRoute.PATCH(
      jsonRequest(`/api/expenses/${fixture.ownReport}`, "PATCH", {
        memo: "Client visit",
        expectedUpdatedAt: ownRevision,
      }),
      params(fixture.ownReport),
    );
    assert.equal(saved.status, 200);
    const otherPatch = await reportRoute.PATCH(
      jsonRequest(`/api/expenses/${fixture.otherReport}`, "PATCH", {
        memo: "not mine",
        expectedUpdatedAt: "1",
      }),
      params(fixture.otherReport),
    );
    assert.equal(otherPatch.status, 404);
    const handOff = await reportRoute.PATCH(
      jsonRequest(`/api/expenses/${fixture.ownReport}`, "PATCH", {
        partyId: fixture.coworker,
        expectedUpdatedAt: await revision(fixture.ownReport),
      }),
      params(fixture.ownReport),
    );
    assert.equal(handOff.status, 403, "a self-service report cannot be handed to another employee");
    assert.equal(((await handOff.json()) as { code: string }).code, "expense_self_only");
    assert.equal(
      (
        await reportRoute.DELETE(
          jsonRequest(`/api/expenses/${fixture.otherReport}`, "DELETE", { expectedUpdatedAt: "1" }),
          params(fixture.otherReport),
        )
      ).status,
      404,
    );

    const receipts = await receiptsRoute.GET(
      jsonRequest(`/api/expenses/${fixture.ownReport}/receipts`, "GET"),
      params(fixture.ownReport),
    );
    assert.equal(receipts.status, 200);
    assert.equal(((await receipts.json()) as { canScan: boolean }).canScan, true);
    assert.equal(
      (
        await receiptsRoute.GET(
          jsonRequest(`/api/expenses/${fixture.otherReport}/receipts`, "GET"),
          params(fixture.otherReport),
        )
      ).status,
      404,
    );
    const scan = new FormData();
    scan.append(
      "files",
      new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], "r.jpg", { type: "image/jpeg" }),
    );
    assert.equal(
      (
        await receiptsRoute.POST(
          new Request(`http://openbooks.test/api/expenses/${fixture.otherReport}/receipts`, {
            method: "POST",
            body: scan,
          }),
          params(fixture.otherReport),
        )
      ).status,
      404,
    );

    const submitOther = await action(
      jsonRequest("/api/expenses/actions", "POST", {
        action: "submit",
        documentId: fixture.otherReport,
      }),
    );
    assert.equal(submitOther.status, 404);
    const post = await action(
      jsonRequest("/api/expenses/actions", "POST", {
        action: "post",
        documentId: fixture.ownReport,
      }),
    );
    assert.equal(post.status, 403, "posting stays with ap.post");

    assert.equal(
      await canReadSubjectRecord(
        fixture.as(fixture.actor, ["expenses.self"]),
        "expense_report",
        fixture.ownReport,
      ),
      true,
    );
    assert.equal(
      await canReadSubjectRecord(
        fixture.as(fixture.actor, ["expenses.self"]),
        "expense_report",
        fixture.otherReport,
      ),
      false,
      "approval history and audit of a coworker's report stay hidden",
    );

    const owner = await withBypassContext(() =>
      expenseListOwnerFilter(fixture.org.orgId, fixture.actor),
    );
    assert.ok(owner, "the list narrows to the holder");
    const listed = await withBypassContext(async () =>
      (
        await db.execute<{ id: string }>(
          sql`
      select d.id from documents d where d.org_id = ${fixture.org.orgId} and d.kind = 'expense_report' and ${owner}`,
          "objects",
        )
      ).map((row) => row.id),
    );
    assert.deepEqual(listed, [fixture.ownReport]);

    const searched = await withBypassContext(() =>
      globalSearch(fixture.as(fixture.actor, ["expenses.self"]), "EXP-SELF"),
    );
    const hits = searched.groups.flatMap((group) => group.hits.map((hit) => hit.id));
    assert.deepEqual(
      hits,
      [fixture.ownReport],
      "search finds the holder's own report and no coworker's",
    );
  } finally {
    await teardown(fixture);
  }
});

test("a self-service report is always the holder's own, and a login with no person creates none", async () => {
  const fixture = await setup();
  try {
    fixture.as(fixture.actor, ["expenses.self"]);
    const created = await createReport(
      jsonRequest(
        "/api/expenses",
        "POST",
        { documentDate: fixture.org.date, lines: taxiLine(fixture) },
        { "Idempotency-Key": randomUUID() },
      ),
    );
    assert.equal(created.status, 201);
    const createdId = ((await created.json()) as { doc: { id: string } }).doc.id;
    assert.equal(
      (await reportsOf(fixture.org.orgId)).find((row) => row.id === createdId)?.party_id,
      fixture.employee,
      "the employee is the holder",
    );

    const before = (await reportsOf(fixture.org.orgId)).length;
    const forCoworker = await createReport(
      jsonRequest(
        "/api/expenses",
        "POST",
        { documentDate: fixture.org.date, partyId: fixture.coworker, lines: taxiLine(fixture) },
        { "Idempotency-Key": randomUUID() },
      ),
    );
    assert.equal(forCoworker.status, 403);
    assert.equal(((await forCoworker.json()) as { code: string }).code, "expense_self_only");

    fixture.as(fixture.unlinked, ["expenses.self"]);
    const unlinked = await createReport(
      jsonRequest(
        "/api/expenses",
        "POST",
        { documentDate: fixture.org.date, lines: taxiLine(fixture) },
        { "Idempotency-Key": randomUUID() },
      ),
    );
    assert.equal(unlinked.status, 403);
    const refusal = (await unlinked.json()) as { code: string; remedy: string };
    assert.equal(refusal.code, "expense_self_unlinked");
    assert.match(refusal.remedy, /link your user to your employee record/);
    assert.equal(
      (
        await reportRoute.GET(
          jsonRequest(`/api/expenses/${fixture.ownReport}`, "GET"),
          params(fixture.ownReport),
        )
      ).status,
      404,
    );
    const nothing = await withBypassContext(() =>
      expenseListOwnerFilter(fixture.org.orgId, fixture.unlinked),
    );
    const listed = await withBypassContext(
      async () =>
        await db.execute<{ id: string }>(
          sql`
      select d.id from documents d where d.org_id = ${fixture.org.orgId} and d.kind = 'expense_report' and ${nothing!}`,
          "objects",
        ),
    );
    assert.deepEqual(listed, [], "a login with no person lists nothing");
    assert.equal(
      (await reportsOf(fixture.org.orgId)).length,
      before,
      "no refused create stored a report",
    );
  } finally {
    await teardown(fixture);
  }
});

test("org-wide expense grants keep working with every employee's reports", async () => {
  const fixture = await setup();
  try {
    fixture.as(fixture.reviewer, ["expenses.read", "expenses.create"]);
    assert.equal(
      (
        await reportRoute.GET(
          jsonRequest(`/api/expenses/${fixture.otherReport}`, "GET"),
          params(fixture.otherReport),
        )
      ).status,
      200,
    );
    const saved = await reportRoute.PATCH(
      jsonRequest(`/api/expenses/${fixture.otherReport}`, "PATCH", {
        memo: "Reviewed",
        expectedUpdatedAt: await revision(fixture.otherReport),
      }),
      params(fixture.otherReport),
    );
    assert.equal(saved.status, 200);
    const created = await createReport(
      jsonRequest(
        "/api/expenses",
        "POST",
        { documentDate: fixture.org.date, partyId: fixture.coworker, lines: taxiLine(fixture) },
        { "Idempotency-Key": randomUUID() },
      ),
    );
    assert.equal(created.status, 201, "an org-wide author files for any employee");
    assert.equal(
      await withBypassContext(() => expenseListOwnerFilter(fixture.org.orgId, fixture.reviewer)),
      null,
      "the list is not narrowed",
    );
    assert.equal(
      await canReadSubjectRecord(
        fixture.as(fixture.reviewer, ["expenses.read"]),
        "expense_report",
        fixture.otherReport,
      ),
      true,
    );

    fixture.as(fixture.reviewer, []);
    assert.equal(
      (
        await reportRoute.GET(
          jsonRequest(`/api/expenses/${fixture.otherReport}`, "GET"),
          params(fixture.otherReport),
        )
      ).status,
      403,
      "no expense grant at all is refused",
    );
  } finally {
    await teardown(fixture);
  }
});

test("a receipt in a format the AI model provider cannot read is refused before it is attached", async () => {
  const fixture = await setup();
  try {
    const { sealSecret } = await import("@openbooks/engine/platform/secrets");
    await withBypassContext(() =>
      db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('ai', ${JSON.stringify(
        {
          enabled: true,
          provider: "openrouter",
          modelSmart: "openai/gpt-4o",
          keyEncrypted: sealSecret("sk-or-test", {
            orgId: fixture.org.orgId,
            purpose: "assistant.ai.key",
          }),
          documentCapture: {
            enabled: true,
            provider: "llm_vision",
            model: "",
            confidenceThreshold: "0.8000",
          },
        },
      )}::jsonb)
       where id = ${fixture.org.orgId}`),
    );
    fixture.as(fixture.actor, ["expenses.self"]);
    const scan = new FormData();
    scan.append(
      "files",
      new File([new TextEncoder().encode("%PDF-1.7\n")], "hotel.pdf", { type: "application/pdf" }),
    );
    const res = await receiptsRoute.POST(
      new Request(`http://openbooks.test/api/expenses/${fixture.ownReport}/receipts`, {
        method: "POST",
        body: scan,
      }),
      params(fixture.ownReport),
    );
    assert.equal(res.status, 422);
    const refusal = (await res.json()) as { code: string; error: string };
    assert.equal(refusal.code, "llm_vision_format");
    assert.match(
      refusal.error,
      /hotel\.pdf: OpenRouter — any model, one key reads JPEG, PNG documents/,
    );
    const stored = await withBypassContext(
      async () =>
        (
          await db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from expense_receipt_captures where org_id = ${fixture.org.orgId}`,
            "objects",
          )
        )[0]!.n,
    );
    assert.equal(stored, 0, "nothing is attached or registered");
  } finally {
    await teardown(fixture);
  }
});
