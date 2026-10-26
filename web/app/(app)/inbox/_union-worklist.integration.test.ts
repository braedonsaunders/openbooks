import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules";
import { resolveEngineSpecifier } from "../../../testing/engine-resolve-hooks";

// Native Flow decisions share one worklist, tab count and navigation badge.
const stateKey = Symbol.for("openbooks.approvals-union-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.approvals-union-test')]
  export async function getAuthz() { return state.authz }
  export async function requirePermission() { return state.authz }
  export function can(authz, permission) { return authz.permissions.has(permission) }
`;
const mockMoney = `
  export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }
`;

stubModules({ intl: true, navigation: false, authz: false, features: false });

// Scoped doubles stay conditioned: the authz and money doubles answer only
// the inbox loader's own imports, which no shared stub shape matches.
const { registerHooks: registerScopedHooks } = await import("node:module");
registerScopedHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../lib/authz" && context.parentURL?.includes("/inbox/")) {
      return { url: "mock:approvals-union-authz", shortCircuit: true };
    }
    if (specifier === "@/lib/money-server" && context.parentURL?.includes("/inbox/")) {
      return { url: "mock:approvals-union-money", shortCircuit: true };
    }
    // Worktree node_modules symlinks to the main checkout's install: pin
    // bare self-imports to this checkout (same modules a real install
    // resolves) so the loader and its transitive engine imports agree.
    const engineUrl = resolveEngineSpecifier(specifier);
    if (engineUrl) return nextResolve(engineUrl, context);
    if (context.parentURL?.startsWith("mock:")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:approvals-union-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:approvals-union-money") {
      return { format: "module", source: mockMoney, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { loadApprovals } = await import("./view.ts");
const { inboxContext, inboxCounts } = await import("../../../lib/inbox-context");
const { writeNotification } = await import("@openbooks/engine/inbox/adapters/notification");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/testing/fixtures").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;

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
    permissions: new Set(["flows.approve", "ap.approve", "ar.approve"]),
    allowedSubsidiaryIds: null,
  };
}

const { seedFlowActors, seedApprovalFlow, seedDraftDocument, grantScratchPermissions } =
  await import("@openbooks/engine/testing/fixtures");
const { submitAndReleaseIfUngated } = await import("@openbooks/engine/flows/submit");
const { submitBudgetScenario } = await import("@openbooks/engine/flows/budget-submission");
const { routeSubjectSubmission } = await import("@openbooks/engine/flows/submission-policy");
const { withOrgTransaction } = await import("@openbooks/engine/platform/db");
const { installEngineSeams } = await import("@openbooks/engine/composition/install");
installEngineSeams();

async function fixture(
  work: (org: ScratchOrg, actors: Awaited<ReturnType<typeof seedFlowActors>>) => Promise<void>,
) {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actors = await withBypass(() => seedFlowActors(org.orgId));
    await withBypass(async () => {
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"flows":true,"budgets":true,"timeTracking":true}'::jsonb) where id=${org.orgId}`,
      );
      await grantScratchPermissions(org.orgId, actors.submitterId, ["budgets.manage"]);
      await grantScratchPermissions(org.orgId, actors.approver1Id, [
        "time.approve",
        "budgets.approve",
      ]);
    });
    await work(org, actors);
  } finally {
    state.authz = null;
    await withBypass(() => dropScratchOrg(org.orgId));
  }
}
function viewer(
  orgId: string,
  id: string,
  permissions = [
    "flows.approve",
    "flows.manage",
    "ap.approve",
    "ar.approve",
    "budgets.approve",
    "time.approve",
  ],
): Authz {
  return { ...authzFor(orgId, id), permissions: new Set(permissions) };
}
async function doc(org: ScratchOrg, actor: string) {
  const id = await withBypass(() =>
    seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actor }),
  );
  await withOrgContext(org.orgId, () => submitAndReleaseIfUngated("vendor_bill", id, actor));
  return id;
}
async function budget(org: ScratchOrg, actor: string) {
  const id = randomUUID();
  await withBypass(async () => {
    await db.execute(sql`insert into budget_scenarios(id,org_id,book_id,fiscal_year,name,kind,status,created_by,updated_by)
   values(${id},${org.orgId},${org.bookId},2026,'Operating budget','budget','draft',${actor},${actor})`);
    await db.execute(sql`insert into budget_lines(org_id,scenario_id,account_id,period_id,amount,created_by,updated_by)
   values(${org.orgId},${id},${org.accounts.revenue},${org.periodId},'50000.0000',${actor},${actor})`);
  });
  const revision = (
    await withBypass(() =>
      db.execute<{ revision: number }>(
        sql`select revision from budget_scenarios where org_id=${org.orgId} and id=${id}`,
        "objects",
      ),
    )
  )[0]!.revision;
  await withOrgContext(org.orgId, () => submitBudgetScenario(org.orgId, actor, id, revision));
  return id;
}
async function week(org: ScratchOrg, actor: string) {
  const id = randomUUID(),
    employee = randomUUID();
  await withBypass(async () => {
    await db.execute(
      sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values(${employee},${org.orgId},'person','Field worker',${org.subsidiaryId},true,'{}'::jsonb)`,
    );
    await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_by,submitted_at,created_by,updated_by)
   values(${id},${org.orgId},${employee},'2026-07-12','submitted',${actor},now(),${actor},${actor})`);
  });
  await withOrgTransaction(org.orgId, () =>
    routeSubjectSubmission({
      orgId: org.orgId,
      actorId: actor,
      subjectKind: "timesheet_week",
      subjectId: id,
    }),
  );
  return id;
}

test("zero-gate records create no human work or approval badge", { skip: !DB }, async () =>
  fixture(async (org, actors) => {
    const id = await doc(org, actors.submitterId);
    await budget(org, actors.submitterId);
    state.authz = viewer(org.orgId, actors.approver1Id);
    const data = await withOrgContext(org.orgId, () => loadApprovals({}));
    assert.ok(data);
    assert.equal(data.total, 0);
    assert.deepEqual(data.approvalRows, []);
    const counts = await withOrgContext(org.orgId, async () => {
      const authz = state.authz as Authz;
      return inboxCounts(authz, await inboxContext(authz));
    });
    assert.equal(counts.approvals, 0);
    assert.equal(
      (
        await withBypass(() =>
          db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${id}`,
            "objects",
          ),
        )
      )[0]?.status,
      "approved",
    );
  }),
);

for (const kind of ["vendor_bill", "budget_scenario", "timesheet_week"] as const) {
  test(
    `${kind} uses the same gate in My Approvals, All Approvals and badge counts`,
    { skip: !DB },
    async () =>
      fixture(async (org, actors) => {
        await withBypass(() =>
          seedApprovalFlow(org.orgId, {
            subjectKind: kind,
            assignees: [{ type: "user", userId: actors.approver1Id }],
            mode: "all",
          }),
        );
        const id = await (kind === "vendor_bill"
          ? doc(org, actors.submitterId)
          : kind === "budget_scenario"
            ? budget(org, actors.submitterId)
            : week(org, actors.submitterId));
        state.authz = viewer(org.orgId, actors.approver1Id);
        await withBypass(() =>
          db.execute(
            sql`update notifications set read_at=now() where org_id=${org.orgId} and user_id=${actors.approver1Id} and kind='approval'`,
          ),
        );
        await withOrgContext(org.orgId, () =>
          writeNotification(db, {
            orgId: org.orgId,
            userId: actors.approver1Id,
            kind: "notice",
            title: "Personal notice",
          }),
        );
        for (const tab of ["mine", "all"] as const) {
          const data = await withOrgContext(org.orgId, () => loadApprovals({ tab }));
          assert.ok(data);
          assert.equal(data.total, 1);
          assert.equal(data.approvalRows.length, 1);
          const row = data.approvalRows[0]!;
          assert.equal(row.kind, kind);
          assert.ok(row.gateId);
          assert.ok(row.href?.includes(id));
          assert.equal(row.canDecide, true);
        }
        const counts = await withOrgContext(org.orgId, async () => {
          const authz = state.authz as Authz;
          return inboxCounts(authz, await inboxContext(authz));
        });
        assert.equal(counts.approvals, 1);
        assert.equal(counts.tasks, 1, "the same gate is not counted again as a task");
        const tasks = await withOrgContext(org.orgId, () => loadApprovals({ tab: "tasks" }));
        assert.ok(tasks);
        assert.deepEqual(tasks.approvalRows, []);
        assert.deepEqual(
          tasks.taskRows.map((row) => row.title),
          ["Personal notice"],
        );
        const searched = await withOrgContext(org.orgId, () =>
          loadApprovals({ q: "no-matching-approval-record" }),
        );
        assert.ok(searched);
        assert.equal(searched.approvalRows.length, 0);
        assert.equal(searched.tabs.find((tab) => tab.key === "mine")?.count, 1);
        state.authz = viewer(org.orgId, actors.submitterId);
        const submitted = await withOrgContext(org.orgId, () =>
          loadApprovals({ tab: "submitted" }),
        );
        assert.ok(submitted);
        assert.ok(submitted.submittedRows.some((row) => row.href?.includes(id)));
      }),
  );
}

test(
  "organization oversight does not grant an unassigned administrator a decision",
  { skip: !DB },
  async () =>
    fixture(async (org, actors) => {
      await withBypass(() =>
        seedApprovalFlow(org.orgId, {
          subjectKind: "vendor_bill",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "all",
        }),
      );
      await doc(org, actors.adminId);
      state.authz = viewer(org.orgId, actors.adminId);
      const mine = await withOrgContext(org.orgId, () => loadApprovals({ tab: "mine" }));
      assert.equal(mine?.total, 0);
      const all = await withOrgContext(org.orgId, () => loadApprovals({ tab: "all" }));
      assert.equal(all?.total, 1);
      assert.equal(all?.approvalRows[0]?.canDecide, false);
      await withBypass(() =>
        db.execute(
          sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.approver1Id},'ap.approve','deny') on conflict(user_id,permission)do update set effect='deny'`,
        ),
      );
      state.authz = viewer(org.orgId, actors.approver1Id);
      const revoked = await withOrgContext(org.orgId, () => loadApprovals({ tab: "all" }));
      assert.equal(revoked?.approvalRows[0]?.canDecide, false);
    }),
);
