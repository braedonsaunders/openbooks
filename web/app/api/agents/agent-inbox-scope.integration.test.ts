import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";

// A restricted assistant.use holder sees only in-scope and shared-account
// findings — never another entity's subjects,
// names, summaries, materiality, or evidence — and must not move B's
// findings through the item, lifecycle, feedback, or report endpoints.
// Record-level denials answer exactly like not-found; the narrative PDF
// (unfilterable free text) needs unrestricted scope. Real routes, real
// database, real role restriction; only the session identity is scripted.
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __agentScopeSession: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}",
      };
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__agentScopeSession.user}",
      };
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { GET: getInbox } = await import("./inbox/route.ts");
const { GET: getItem, PATCH: patchItem } = await import("../continuous-close/items/[id]/route.ts");
const { PUT: putFeedback } = await import("../continuous-close/items/[id]/feedback/route.ts");
const { GET: getReportPdf } = await import("../continuous-close/reports/[runId]/pdf/route.ts");

const SCOPED_PERMS = ["assistant.use", "assistant.write", "gl.read"];

async function seedFinding(
  orgId: string,
  subjectType: string | null,
  subjectId: string | null,
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, confidence, materiality,
     subject_type, subject_id, summary)
    values (${id}, ${orgId}, 'accounting', 'stale_unreconciled_item', 'test', ${`fp-${id}`},
      'warning', '0.8', '2500', ${subjectType}, ${subjectId}, '{"headline":"scope probe"}'::jsonb)`),
  );
  return id;
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const owner = await withBypassContext(() => createScratchUser(org.orgId, "Owner", "scope_owner"));
  const scoped = await withBypassContext(() =>
    createScratchUser(org.orgId, "A clerk", "scope_clerk"),
  );
  const accts = (
    await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`
    select id from accounts where org_id=${org.orgId} and is_active order by number limit 3`,
        "objects",
      ),
    )
  ).map((r) => r.id);
  assert.equal(accts.length, 3);
  const [acctA, acctB, acctN] = accts as [string, string, string];
  let subB = "";
  await withBypassContext(async () => {
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='scope_owner'`,
    );
    const sub = await db.execute<{ id: string }>(
      sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      select ${randomUUID()}, ${org.orgId}, s.id, 'Entity B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
        from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`,
      "objects",
    );
    subB = sub[0]!.id;
    await db.execute(sql`
      update app_roles set permissions=${JSON.stringify(SCOPED_PERMS)}::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id=${org.orgId} and key='scope_clerk'`);
    await db.execute(sql`update accounts set subsidiary_id=${org.subsidiaryId} where id=${acctA}`);
    await db.execute(sql`update accounts set subsidiary_id=${subB} where id=${acctB}`);
    await db.execute(sql`update accounts set subsidiary_id=null where id=${acctN}`);
  });
  const itemA = await seedFinding(org.orgId, "account", acctA);
  const itemB = await seedFinding(org.orgId, "account", acctB);
  const itemN = await seedFinding(org.orgId, "account", acctN);
  const itemX = await seedFinding(org.orgId, "vendor", randomUUID());
  const user = (id: string, name: string): SessionUser => ({
    id,
    orgId: org.orgId,
    name,
    email: `${name}@scratch.test`,
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: id,
  });
  const asOwner = () => {
    state.user = user(owner, "owner");
  };
  const asScoped = () => {
    state.user = user(scoped, "clerk");
  };
  const itemParams = (id: string) => ({ params: Promise.resolve({ id }) });
  const close = async () => {
    state.user = null;
    await dropScratchOrg(org.orgId);
  };
  return {
    org,
    subB,
    scoped,
    acctA,
    acctB,
    itemA,
    itemB,
    itemN,
    itemX,
    asOwner,
    asScoped,
    itemParams,
    close,
  };
}

test("a restricted caller lists only their entity’s findings", async () => {
  const f = await fixture();
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped();
      const scoped = (await (await getInbox(new Request("https://x/api/agents/inbox"))).json()) as {
        ok: boolean;
        total: number;
        rows: { id: string }[];
      };
      assert.equal(scoped.ok, true);
      assert.deepEqual(scoped.rows.map((i) => i.id).sort(), [f.itemA, f.itemN].sort());
      assert.equal(scoped.total, 2);
      f.asOwner();
      const full = (await (await getInbox(new Request("https://x/api/agents/inbox"))).json()) as {
        ok: boolean;
        total: number;
      };
      assert.equal(full.ok, true);
      assert.equal(full.total, 4);
    });
  } finally {
    await f.close();
  }
});

test("a restricted caller reads only their entity’s finding detail", async () => {
  const f = await fixture();
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped();
      const hit = (await (
        await getItem(new Request("https://x/"), f.itemParams(f.itemA))
      ).json()) as { item: { id: string } };
      assert.equal(hit.item.id, f.itemA);
      const shared = (await (
        await getItem(new Request("https://x/"), f.itemParams(f.itemN))
      ).json()) as { item: { id: string } };
      assert.equal(shared.item.id, f.itemN);
      for (const [label, id] of [
        ["other entity", f.itemB],
        ["unresolved subject", f.itemX],
      ] as const) {
        const res = await getItem(new Request("https://x/"), f.itemParams(id));
        assert.equal(res.status, 404, label);
      }
    });
  } finally {
    await f.close();
  }
});

test("a restricted caller cannot move another entity’s finding lifecycle", async () => {
  const f = await fixture();
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped();
      const denied = await patchItem(
        new Request("https://x/", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "review" }),
        }),
        f.itemParams(f.itemB),
      );
      assert.equal(denied.status, 404);
      const statusB = (
        await db.execute<{ status: string }>(
          sql`select status from ai_work_items where id=${f.itemB}`,
          "objects",
        )
      )[0]!.status;
      assert.equal(statusB, "open", "the refused transition wrote nothing");
      const allowed = await patchItem(
        new Request("https://x/", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "review" }),
        }),
        f.itemParams(f.itemA),
      );
      assert.equal(allowed.status, 200);
      const statusA = (
        await db.execute<{ status: string }>(
          sql`select status from ai_work_items where id=${f.itemA}`,
          "objects",
        )
      )[0]!.status;
      assert.equal(statusA, "in_review");
    });
  } finally {
    await f.close();
  }
});

test("a restricted caller cannot rate another entity’s finding", async () => {
  const f = await fixture();
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped();
      const denied = await putFeedback(
        new Request("https://x/", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rating: "helpful", comment: "noted" }),
        }),
        f.itemParams(f.itemB),
      );
      assert.equal(denied.status, 404);
      const count = Number(
        (
          await db.execute<{ n: string }>(
            sql`select count(*) as n from ai_work_item_feedback where work_item_id=${f.itemB}`,
            "objects",
          )
        )[0]!.n,
      );
      assert.equal(count, 0, "no feedback row persists from the refused write");
    });
  } finally {
    await f.close();
  }
});

test("restricted work-item actions follow document, reconciliation, budget, and shared-account scope", async () => {
  const f = await fixture();
  try {
    const documentA = randomUUID();
    const documentB = randomUUID();
    const reconciliationA = randomUUID();
    const budgetA = randomUUID();
    const budgetMixed = randomUUID();
    const budgetAccountA = randomUUID();
    const budgetAccountB = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, subsidiary_id)
        values (${budgetAccountA}, ${f.org.orgId}, ${"BA-" + budgetAccountA.slice(0, 8)}, 'Entity A budget expense', 'expense', ${f.org.subsidiaryId}),
               (${budgetAccountB}, ${f.org.orgId}, ${"BB-" + budgetAccountB.slice(0, 8)}, 'Entity B budget expense', 'expense', ${f.subB})`);

      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, subsidiary_id, document_date, currency, subtotal, tax_total, total)
        values (${documentA}, ${f.org.orgId}, 'vendor_bill', 'draft', 'scope-a', ${f.org.subsidiaryId}, ${f.org.date}, 'CAD', 0, 0, 0),
               (${documentB}, ${f.org.orgId}, 'vendor_bill', 'draft', 'scope-b', ${f.subB}, ${f.org.date}, 'CAD', 0, 0, 0)
      `);
      await db.execute(sql`
        insert into reconciliations (id, org_id, account_id, through_date, statement_balance, currency)
        values (${reconciliationA}, ${f.org.orgId}, ${f.acctA}, ${f.org.date}, 0, 'CAD')
      `);
      await db.execute(sql`
        insert into budget_scenarios (id, org_id, book_id, fiscal_year, name)
        values (${budgetA}, ${f.org.orgId}, ${f.org.bookId}, 2026, 'In scope'),
               (${budgetMixed}, ${f.org.orgId}, ${f.org.bookId}, 2026, 'Mixed scope')
      `);
      await db.execute(sql`
        insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
        values (${f.org.orgId}, ${budgetA}, ${budgetAccountA}, ${f.org.periodId}, ${f.org.subsidiaryId}, 1),
               (${f.org.orgId}, ${budgetMixed}, ${budgetAccountA}, ${f.org.periodId}, ${f.org.subsidiaryId}, 1),
               (${f.org.orgId}, ${budgetMixed}, ${budgetAccountB}, ${f.org.periodId}, ${f.subB}, 1)
      `);
    });
    const itemDocumentA = await seedFinding(f.org.orgId, "documents", documentA);
    const itemDocumentB = await seedFinding(f.org.orgId, "documents", documentB);
    const itemReconciliation = await seedFinding(f.org.orgId, "reconciliation", reconciliationA);
    const itemBudgetA = await seedFinding(f.org.orgId, "budget", budgetA);
    const itemBudgetMixed = await seedFinding(f.org.orgId, "budget", budgetMixed);

    await withOrgContext(f.org.orgId, async () => {
      f.asScoped();
      for (const id of [itemDocumentA, itemReconciliation, itemBudgetA, f.itemN]) {
        const result = await patchItem(
          new Request("https://x/", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "note", body: "Reviewed within my entity." }),
          }),
          f.itemParams(id),
        );
        assert.equal(result.status, 200, `in-scope subject ${id} remains actionable`);
      }
      for (const id of [itemDocumentB, itemBudgetMixed]) {
        const result = await patchItem(
          new Request("https://x/", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "note", body: "Should not be visible." }),
          }),
          f.itemParams(id),
        );
        assert.equal(result.status, 404, `out-of-scope subject ${id} stays hidden`);
      }
      const feedback = await putFeedback(
        new Request("https://x/", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rating: "helpful" }),
        }),
        f.itemParams(itemDocumentA),
      );
      assert.equal(feedback.status, 200, "document findings accept feedback in scope");

      const assignment = await getItem(new Request("https://x/"), f.itemParams(itemDocumentA));
      const detail = (await assignment.json()) as {
        assignment: { assigneeUserId: string | null } | null;
        notes: unknown[];
      };
      assert.equal(assignment.status, 200);
      assert.equal(
        detail.notes.length,
        1,
        "the detail endpoint returns notes for a scoped document finding",
      );
      assert.equal(detail.assignment?.assigneeUserId ?? null, null);

      await withBypassContext(() =>
        db.execute(sql`
        update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [f.subB] })}::jsonb
         where org_id=${f.org.orgId} and key='scope_clerk'
      `),
      );
      const childAssignment = await patchItem(
        new Request("https://x/", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "assign", assigneeUserId: f.scoped }),
        }),
        f.itemParams(f.itemB),
      );
      assert.equal(
        childAssignment.status,
        200,
        "assigning a finding in a child subsidiary does not require root access",
      );
    });
  } finally {
    await f.close();
  }
});

test("the narrative PDF needs unrestricted scope", async () => {
  const f = await fixture();
  try {
    await withOrgContext(f.org.orgId, async () => {
      f.asScoped();
      const denied = await getReportPdf(new Request("https://x/"), {
        params: Promise.resolve({ runId: randomUUID() }),
      });
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: "requires unrestricted subsidiary access" });
      f.asOwner();
      // No run seeded: the unrestricted caller passes the scope gate and
      // reaches the missing-report shape.
      const passed = await getReportPdf(new Request("https://x/"), {
        params: Promise.resolve({ runId: randomUUID() }),
      });
      assert.equal(passed.status, 404);
    });
  } finally {
    await f.close();
  }
});
