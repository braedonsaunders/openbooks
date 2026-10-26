import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { resolveEngineSpecifier } from "../../../testing/engine-resolve-hooks";

// the dashboard "Pending approvals" widget lists the top-5
// pending FLOW GATES while the tile counts the unified worklist, so the
// widget reads "—" next to a 97 tile. Both lists must read the union.
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ intl: true });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    // Worktree node_modules symlinks to the main checkout's install: pin
    // bare self-imports to this checkout (same modules a real install
    // resolves) so the loader and its transitive engine imports agree.
    const engineUrl = resolveEngineSpecifier(specifier);
    if (engineUrl) return nextResolve(engineUrl, context);
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { withBypassContext, db, withBypass, withOrgContext } =
  await import("@openbooks/engine/platform/db");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedApprovalFlow,
} = await import("@openbooks/engine/testing/fixtures");
const { installEngineSeams } = await import("@openbooks/engine/composition/install");
const { submitBudgetScenario } = await import("@openbooks/engine/flows/budget-submission");
const { submitAndReleaseIfUngated } = await import("@openbooks/engine/flows/submit");
installEngineSeams();
const { loadDashboardMetrics } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/testing/fixtures").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;

// The approval tiles and lists this approver can see. The default read covers
// every built-in widget, which now includes the Sentinel risk tiles this
// fixture is not granted; the loader reads only the widgets it is handed.
const APPROVAL_WIDGETS = ["kpi-pending-approvals", "list-pending-approvals", "personal-inbox"];

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId,
      email: `${userId}@test`,
      name: "Union Approver",
      orgId,
      roles: [{ key: "approver", name: "approver" }],
      envKind: "sandbox",
      productionOrgId: orgId,
      isSuperAdmin: false,
      homeUserId: userId,
      homeOrgId: orgId,
    },
    permissions: new Set([
      "dashboard.read",
      "gl.read",
      "ar.read",
      "ap.read",
      "flows.approve",
      "ap.approve",
      "ar.approve",
    ]),
    allowedSubsidiaryIds: null,
  };
}

/** An invoice awaiting the tenant's configured review. */
async function postedPendingDoc(
  org: ScratchOrg,
  submittedBy: string,
  approver: string,
): Promise<{ docId: string; number: string }> {
  const doc = randomUUID();
  const number = `WIDGET-${doc.slice(0, 8)}`;
  await withBypassContext(async () => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: "customer_invoice",
      mode: "any",
      preventSelfApproval: true,
      assignees: [{ type: "user", userId: approver }],
    });
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,due_date,currency,fx_rate,subtotal,tax_total,total,created_by)
      values(${doc},${org.orgId},'customer_invoice','draft',${number},${org.subsidiaryId},${org.customerId},${org.date},'2027-12-31','CAD','1','1000',0,'1000',${submittedBy})`);
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount)
      values(${org.orgId},${doc},1,${org.accounts.revenue},'1','1000','1000','0')`);
  });
  await withOrgContext(org.orgId, () =>
    submitAndReleaseIfUngated("customer_invoice", doc, submittedBy),
  );
  return { docId: doc, number };
}

/** A budget submitted through its configured native Flow. */
async function postedPendingBudget(
  org: ScratchOrg,
  submittedBy: string,
  approver: string,
): Promise<{ budgetId: string; name: string }> {
  const budget = randomUUID();
  const name = `WIDGET-BUDGET-${budget.slice(0, 8)}`;
  await withBypassContext(() =>
    db.execute(sql`insert into budget_scenarios(id,org_id,book_id,fiscal_year,name,kind,status,created_by,updated_by)
    values(${budget},${org.orgId},${org.bookId},2026,${name},'budget','draft',${submittedBy},${submittedBy})`),
  );
  await withBypassContext(() =>
    db.execute(sql`insert into budget_lines(org_id,scenario_id,account_id,period_id,amount,created_by,updated_by)
    values(${org.orgId},${budget},${org.accounts.revenue},${org.periodId},'-50000.0000',${submittedBy},${submittedBy})`),
  );
  await withBypassContext(async () => {
    await grantScratchPermissions(org.orgId, submittedBy, ["budgets.manage"]);
    await grantScratchPermissions(org.orgId, approver, ["budgets.approve"]);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "budget_scenario",
      mode: "any",
      preventSelfApproval: true,
      assignees: [{ type: "user", userId: approver }],
    });
  });
  await withOrgContext(org.orgId, () => submitBudgetScenario(org.orgId, submittedBy, budget, 1));
  return { budgetId: budget, name };
}

function budgetAuthzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId,
      email: `${userId}@test`,
      name: "Widget Budget Approver",
      orgId,
      roles: [{ key: "approver", name: "approver" }],
      envKind: "sandbox",
      productionOrgId: orgId,
      isSuperAdmin: false,
      homeUserId: userId,
      homeOrgId: orgId,
    },
    permissions: new Set([
      "dashboard.read",
      "gl.read",
      "ar.read",
      "ap.read",
      "flows.approve",
      "ap.approve",
      "ar.approve",
      "budgets.approve",
    ]),
    allowedSubsidiaryIds: null,
  };
}

test(
  "dashboard approval widgets list pending budgets with their checker target",
  { skip: !DB },
  async () => {
    // the tile counts the unified worklist (budgets included), so
    // the widget rows must map budget items to a linkable target too — not
    // the gate-shaped fallthrough.
    const org = await withBypass(() => createScratchOrg());
    try {
      const submitter = await withBypass(() =>
        createScratchUser(org.orgId, "Widget Budget Submitter", "accountant"),
      );
      const approver = await withBypass(() =>
        createScratchUser(org.orgId, "Widget Budget Approver", "approver"),
      );
      await withBypass(() =>
        db.execute(
          sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'), '{features,budgets}', 'true') where id = ${org.orgId}`,
        ),
      );
      const pending = await withBypass(() => postedPendingBudget(org, submitter, approver));
      const metrics = await withOrgContext(org.orgId, () =>
        loadDashboardMetrics(
          budgetAuthzFor(org.orgId, approver as unknown as string),
          APPROVAL_WIDGETS,
        ),
      );
      assert.equal(metrics.pendingApprovals, 1, "tile counts the pending budget");
      const row = metrics.pendingApprovalList.find((r) => r.title === pending.name);
      assert.ok(row, "pending list maps the budget row");
      assert.equal(row!.targetKind, "budget_scenario");
      assert.equal(row!.targetId, pending.budgetId);
      assert.equal(row!.href, `/budgets?budget=${pending.budgetId}`);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test("dashboard approval widgets link the configured document review", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const submitter = await withBypass(() =>
      createScratchUser(org.orgId, "Widget Submitter", "accountant"),
    );
    const approver = await withBypass(() =>
      createScratchUser(org.orgId, "Widget Approver", "approver"),
    );
    const pending = await withBypass(() => postedPendingDoc(org, submitter, approver));
    const metrics = await withOrgContext(org.orgId, () =>
      loadDashboardMetrics(authzFor(org.orgId, approver as unknown as string), APPROVAL_WIDGETS),
    );
    assert.equal(metrics.pendingApprovals, 1, "tile counts the configured invoice gate");
    assert.equal(
      metrics.pendingApprovalList.length,
      1,
      "pending list reads the union, not gates-only",
    );
    assert.equal(metrics.myApprovalList.length, 1, "my inbox reads the union, not gates-only");
    assert.ok(
      metrics.pendingApprovalList.some((r) => r.title === pending.number),
      "union row carries the document number",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
