import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { IntlMessageFormat } from "intl-messageformat";
import { stubModules } from "../../../testing/stub-modules";
import { resolveEngineSpecifier } from "../../../testing/engine-resolve-hooks";
import englishMessages from "../../../messages/en";

// Governed equity actions in the Inbox: the requester sees a pending action
// under Submitted by me with its withdrawal, labels and figures, inside their
// legal-entity scope only; an approver whose role carries only the equity
// grants decides it from their tasks; and All approvals lists every pending
// approval in the organization, whoever it is assigned to, inside the
// viewer's legal-entity boundary, offering decisions only where the viewer
// may decide.
const stateKey = Symbol.for("openbooks.inbox-equity-submissions-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

// The English catalog, formatted the way next-intl formats it, so labels
// are asserted as an operator reads them.
const intlKey = Symbol.for("openbooks.inbox-equity-submissions-intl");
function lookup(ns: string | undefined, key: string): unknown {
  let node: unknown = englishMessages;
  for (const part of `${ns ? `${ns}.` : ""}${key}`.split(".")) {
    node =
      node != null && typeof node === "object"
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  return node;
}
(globalThis as typeof globalThis & Record<symbol, unknown>)[intlKey] = {
  has: (ns: string | undefined, key: string) => typeof lookup(ns, key) === "string",
  format: (ns: string | undefined, key: string, values?: Record<string, unknown>) => {
    const message = lookup(ns, key);
    return typeof message === "string"
      ? String(new IntlMessageFormat(message, "en").format(values as never))
      : key;
  },
};
const intlSource = `
  const intl = globalThis[Symbol.for('openbooks.inbox-equity-submissions-intl')]
  export async function getTranslations(ns) {
    const t = (key, values) => intl.format(ns, key, values)
    t.has = (key) => intl.has(ns, key)
    return t
  }
  export async function getMessages() { return {} }
  export async function getLocale() { return 'en' }
  export async function getTimeZone() { return 'UTC' }
  export async function getFormatter() {
    return {
      dateTime: (value, options) => new Intl.DateTimeFormat('en', { ...(options ?? {}), timeZone: 'UTC' }).format(value),
      number: (value, options) => new Intl.NumberFormat('en', options).format(value),
    }
  }
`;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.inbox-equity-submissions-test')]
  export async function getAuthz() { return state.authz }
  export async function requirePermission() { return state.authz }
  export function can(authz, permission) { return authz.permissions.has(permission) }
`;
const mockMoney = `
  export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }
`;

stubModules({ intl: intlSource, navigation: false, authz: false, features: false });

const { registerHooks: registerScopedHooks } = await import("node:module");
registerScopedHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../lib/authz" && context.parentURL?.includes("/inbox/")) {
      return { url: "mock:inbox-equity-authz", shortCircuit: true };
    }
    if (specifier === "@/lib/money-server" && context.parentURL?.includes("/inbox/")) {
      return { url: "mock:inbox-equity-money", shortCircuit: true };
    }
    const engineUrl = resolveEngineSpecifier(specifier);
    if (engineUrl) return nextResolve(engineUrl, context);
    if (context.parentURL?.startsWith("mock:")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:inbox-equity-authz")
      return { format: "module", source: mockAuthz, shortCircuit: true };
    if (url === "mock:inbox-equity-money")
      return { format: "module", source: mockMoney, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext, withOrgTransaction } =
  await import("@openbooks/engine/platform/db");
const { installEngineSeams } = await import("@openbooks/engine/composition/install");
const { createScratchUser, dropScratchOrgReporting, seedApprovalFlow, grantScratchPermissions } =
  await import("@openbooks/engine/testing/fixtures");
const { setupEquityWorld } = await import("@openbooks/engine/testing/equity-world");
const { changePlanReserve, createPlan } = await import("@openbooks/engine/equity");
const { worklistApprovalsPage } = await import("@openbooks/engine/flows/approval-worklist");
const { loadApprovals } = await import("./view.ts");
const { inboxContext, inboxCounts } = await import("../../../lib/inbox-context");
const { resolveApprovalSubjects } = await import("../../../lib/approval-subjects");
const { postEntry } = await import("@openbooks/engine/testing/journal/post-entry");
const { proposeHistoricalContributionFixture } =
  await import("@openbooks/engine/testing/historical-translations");
const { submitFinancialChange } = await import("@openbooks/engine/flows/financial-changes-adapter");
const { routeSubjectSubmission } = await import("@openbooks/engine/flows/submission-policy");
const { financialChangeEventLabel } = await import("@openbooks/engine/platform/financial-changes");
type Authz = import("@/lib/authz.ts").Authz;

installEngineSeams();
const EQUITY_ACTION_SUBJECT_KIND = "equity_action";
const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(
  orgId: string,
  userId: string,
  role: string,
  permissions: string[],
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Authz {
  return {
    user: {
      id: userId,
      email: `${userId}@test`,
      name: role,
      orgId,
      roles: [{ key: role, name: role }],
      envKind: "sandbox",
      productionOrgId: orgId,
      isSuperAdmin: false,
      homeUserId: userId,
      homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds,
  } as Authz;
}

test(
  "a pending equity action is the requester's submission and the equity approver's task",
  { skip: !DB },
  async () => {
    const w = await withBypassContext(() => setupEquityWorld());
    try {
      await withBypassContext(() =>
        seedApprovalFlow(w.org.orgId, {
          subjectKind: EQUITY_ACTION_SUBJECT_KIND,
          assignees: [{ type: "user", userId: w.approverId }],
          mode: "any",
        }),
      );
      const plan = await createPlan({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        code: "EIP",
        name: "Equity incentive plan",
        shareClassId: w.commonClassId,
        effectiveOn: "2026-01-01",
        reservedShares: "4000000",
        recycleForfeited: true,
        recycleExpired: true,
        recycleRepurchased: false,
      });
      const held = await changePlanReserve({
        orgId: w.org.orgId,
        actorId: w.managerId,
        planId: plan.id,
        effectiveOn: "2026-07-15",
        shareDelta: "1000",
        reason: "Board approved a pool top-up",
      });
      assert.equal(held.status, "pending_approval");

      state.authz = authzFor(w.org.orgId, w.managerId, "equity_manager", [
        "equity.read",
        "equity.manage",
      ]);
      const mine = await withOrgContext(w.org.orgId, () => loadApprovals({ tab: "submitted" }));
      const row = mine!.submittedRows.find(
        (candidate) => candidate.kind === EQUITY_ACTION_SUBJECT_KIND,
      );
      assert.ok(row, "the requester sees the pending action under Submitted by me");
      assert.match(row.documentNumber, /EIP/, "the row names the record the action concerns");
      assert.equal(row.withdrawEndpoint, `/api/equity/requests/${held.requestId}/withdraw`);
      assert.equal(row.href, `/equity?request=${held.requestId}`);
      assert.equal(mine!.submittedTotal, 1);
      assert.equal(
        row.kindLabel,
        "Equity action · Reserve change",
        "the kind names the action in sentence case",
      );
      assert.equal(
        row.statusLabel,
        "Pending approval",
        "the status reads as a label, never the raw enum",
      );
      assert.equal(row.amount, "+1,000 shares", "a reserve change shows its signed share quantity");
      assert.equal(row.party, null, "a plan reserve change concerns no holder");
      assert.doesNotMatch(
        row.waitingSinceDate,
        /^\d{4}-\d{2}-\d{2}$/,
        "the waiting date is formatted, not ISO",
      );
      assert.equal(
        row.waitingSinceDate,
        new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
          new Date(row.waitingSince),
        ),
      );

      // A requester whose legal-entity scope no longer reaches the action does not see it.
      state.authz = authzFor(
        w.org.orgId,
        w.managerId,
        "equity_manager",
        ["equity.read", "equity.manage"],
        new Set(),
      );
      const outside = await withOrgContext(w.org.orgId, () => loadApprovals({ tab: "submitted" }));
      assert.equal(
        outside!.submittedRows.some((candidate) => candidate.kind === EQUITY_ACTION_SUBJECT_KIND),
        false,
      );
      state.authz = authzFor(
        w.org.orgId,
        w.managerId,
        "equity_manager",
        ["equity.read", "equity.manage"],
        new Set([w.org.subsidiaryId]),
      );
      const inside = await withOrgContext(w.org.orgId, () => loadApprovals({ tab: "submitted" }));
      assert.equal(
        inside!.submittedRows.some((candidate) => candidate.kind === EQUITY_ACTION_SUBJECT_KIND),
        true,
      );

      // The approver holds only the equity grants: the action is among their tasks, ready to decide.
      state.authz = authzFor(w.org.orgId, w.approverId, "equity_approver", [
        "equity.read",
        "equity.approve",
      ]);
      const tasks = await withOrgContext(w.org.orgId, () => loadApprovals({ tab: "tasks" }));
      const task = tasks!.taskRows.find((candidate) => candidate.id.startsWith("equity_action:"));
      assert.ok(task, "the approver's tasks list the equity action");
      assert.deepEqual(
        task.actions.map((action) => action.key),
        ["approve", "reject"],
      );
      assert.equal(task.href, `/equity?request=${held.requestId}`);
      assert.doesNotMatch(
        task.subtitle ?? "",
        /\d{4}-\d{2}-\d{2}/,
        "the free-text detail carries no raw date",
      );
      assert.match(
        task.waitingSinceLabel ?? "",
        /^Waiting since [A-Z][a-z]{2} \d{1,2}, \d{4}$/,
        "the waiting date renders in the viewer locale",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

/** A pending accounting-event approval held by a live Flow run, assigned to a role. */
async function pendingFinancialChangeGate(
  orgId: string,
  subsidiaryId: string,
  submitterId: string,
  role: string,
): Promise<{ changeId: string; gateId: string }> {
  await withBypassContext(() =>
    grantScratchPermissions(orgId, submitterId, ["close.run", "gl.post", "documents.read"]),
  );
  await withBypassContext(() =>
    db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${orgId}`),
  );
  await withBypassContext(async () => {
    const assignees = await db.execute<{ id: string }>(
      sql`select a.user_id as id from role_assignments a
      join app_roles r on r.org_id=a.org_id and r.id=a.role_id where a.org_id=${orgId} and r.key=${role}`,
      "objects",
    );
    for (const assignee of assignees)
      await grantScratchPermissions(orgId, assignee.id, ["close.run", "documents.read"]);
    await seedApprovalFlow(orgId, {
      subjectKind: "financial_change",
      mode: "any",
      assignees: [{ type: "role", role }],
      preventSelfApproval: true,
    });
  });
  return withOrgTransaction(orgId, async () => {
    const basis = (
      await db.execute<{
        book: string;
        period: string;
        equity: string;
        bank: string;
        currency: string;
      }>(
        sql`
      select b.id as book,p.id as period,
        (select id from accounts where org_id=${orgId} and type='equity' order by id limit 1) as equity,
        (select id from accounts where org_id=${orgId} and type='asset_bank' order by id limit 1) as bank,
        public.accounting_book_currency(${orgId},b.id,${subsidiaryId}) as currency
      from accounting_books b join accounting_periods p on p.org_id=b.org_id
      where b.org_id=${orgId} and b.is_primary and p.starts_on<='2026-07-15' and p.ends_on>='2026-07-15'
        and not p.is_adjustment order by p.id limit 1`,
        "objects",
      )
    )[0]!;
    const posted = await postEntry(db, {
      orgId,
      actorId: submitterId,
      bookId: basis.book,
      periodId: basis.period,
      subsidiaryId,
      entryNumber: `CAP-${randomUUID()}`,
      postingDate: "2026-07-15",
      currency: basis.currency,
      origin: "manual",
      lines: [
        {
          accountId: basis.equity,
          subsidiaryId,
          amount: "-100",
          currency: basis.currency,
          txnAmount: "-100",
          fxRate: "1",
        },
        {
          accountId: basis.bank,
          subsidiaryId,
          amount: "100",
          currency: basis.currency,
          txnAmount: "100",
          fxRate: "1",
        },
      ],
    });
    const source = (
      await db.execute<{ id: string }>(
        sql`select id from journal_lines
      where org_id=${orgId} and entry_id=${posted.entryId} and account_id=${basis.equity}`,
        "objects",
      )
    )[0]!;
    const changeId = await proposeHistoricalContributionFixture({
      orgId,
      actorId: submitterId,
      sourceLineId: source.id,
      measurementCurrency: basis.currency,
      presentationCurrency: basis.currency === "CAD" ? "USD" : "CAD",
      historicalDate: "2026-07-15",
      amount: "-100",
      rate: "1.2",
    });
    await db.execute(sql`insert into resource_grants(org_id,resource_type,resource_id,principal_type,principal_id,access,created_by)
      select ${orgId},'folder',f.folder_id,'user',a.user_id,'viewer',${submitterId}
      from financial_changes c join files f on f.org_id=c.org_id and f.id=(c.payload->'evidence'->'instruction'->'layers'->0->'source'->>'fileId')::uuid
      join role_assignments a on a.org_id=c.org_id join app_roles r on r.org_id=a.org_id and r.id=a.role_id
      where c.org_id=${orgId} and c.id=${changeId} and r.key=${role}`);
    await submitFinancialChange(orgId, changeId, submitterId);
    const gates = await db.execute<{ id: string }>(
      sql`select id from flow_gates
      where org_id=${orgId} and subject_kind='financial_change' and subject_id=${changeId} and status='pending'`,
      "objects",
    );
    assert.equal(gates.length, 1);
    return { changeId, gateId: gates[0]!.id };
  });
}

test(
  "All approvals lists every pending approval in the organization within the viewer's legal entities",
  { skip: !DB },
  async () => {
    const w = await withBypassContext(() => setupEquityWorld());
    try {
      const { org } = w;
      const { controllerId, adminId } = await withBypassContext(async () => {
        await db.execute(
          sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,flows}', 'true') where id = ${org.orgId}`,
        );
        await createScratchUser(org.orgId, "Accounting Approver", "approver");
        return {
          controllerId: await createScratchUser(org.orgId, "Org Controller", "controller"),
          adminId: await createScratchUser(org.orgId, "Org Admin", "admin"),
        };
      });
      await withBypassContext(() =>
        seedApprovalFlow(org.orgId, {
          subjectKind: "equity_action",
          assignees: [{ type: "user", userId: w.approverId }],
          mode: "any",
        }),
      );
      const plan = await createPlan({
        orgId: org.orgId,
        actorId: w.managerId,
        subsidiaryId: org.subsidiaryId,
        code: "EIP",
        name: "Equity incentive plan",
        shareClassId: w.commonClassId,
        effectiveOn: "2026-01-01",
        reservedShares: "4000000",
        recycleForfeited: true,
        recycleExpired: true,
        recycleRepurchased: false,
      });
      const held = await changePlanReserve({
        orgId: org.orgId,
        actorId: w.managerId,
        planId: plan.id,
        effectiveOn: "2026-07-15",
        shareDelta: "1000",
        reason: "Board approved a pool top-up",
      });
      assert.equal(held.status, "pending_approval");
      const change = await withBypassContext(() =>
        pendingFinancialChangeGate(org.orgId, org.subsidiaryId, w.managerId, "approver"),
      );

      // The controller oversees approvals (flows.manage) and is assigned none of them.
      const controller = (allowed: ReadonlySet<string> | null) =>
        authzFor(org.orgId, controllerId, "controller", ["flows.manage", "flows.approve"], allowed);
      state.authz = controller(null);
      const all = await withOrgContext(org.orgId, () => loadApprovals({ tab: "all" }));
      assert.equal(all!.tabKey, "all");
      const equityRow = all!.approvalRows.find((r) => r.kind === "equity_action");
      const changeRow = all!.approvalRows.find((r) => r.gateId === change.gateId);
      assert.ok(equityRow, "the pending equity action assigned to another approver is listed");
      assert.ok(changeRow, "the pending accounting event, which has no document, is listed");
      assert.equal(all!.total, 2);
      assert.deepEqual([...all!.approvalRows.map((r) => r.kind)].sort(), [
        "equity_action",
        "financial_change",
      ]);
      assert.equal(equityRow.kindLabel, "Equity action · Reserve change");
      assert.equal(equityRow.amount, "+1,000 shares");
      assert.equal(equityRow.assignee, "Equity Approver", "the row names who the gate waits on");
      assert.equal(
        changeRow.assignee,
        "Accounting Approver",
        "role targeting freezes the resolved assignee",
      );
      assert.equal(
        changeRow.kindLabel,
        financialChangeEventLabel("historical_translation_contribution"),
        "an accounting event names its operation",
      );
      for (const row of [equityRow, changeRow]) {
        assert.equal(row.canDecide, false, "another approver's gate offers no decision");
        assert.equal(row.canDelegate, true, "native Flow-management authority permits hand-off");
        assert.equal(row.awaitingAnotherApprover, false);
      }
      assert.equal(all!.emptyTitle, "Nothing pending");
      assert.equal(all!.gatesPresent, true);

      // The same organization reading through the engine, with kind counts.
      const engine = await withOrgContext(org.orgId, () =>
        worklistApprovalsPage(
          org.orgId,
          controllerId,
          {
            roles: ["controller"],
            allowedSubsidiaryIds: null,
            includeFlows: true,
            audience: "organization",
          },
          { limit: 25, offset: 0 },
        ),
      );
      assert.equal(engine.total, 2);
      assert.deepEqual(Object.fromEntries(engine.kindCounts), {
        equity_action: 1,
        financial_change: 1,
      });
      const filtered = await withOrgContext(org.orgId, () =>
        worklistApprovalsPage(
          org.orgId,
          controllerId,
          {
            roles: ["controller"],
            allowedSubsidiaryIds: null,
            includeFlows: true,
            audience: "organization",
          },
          { limit: 25, offset: 0, kind: "equity_action" },
        ),
      );
      assert.deepEqual(
        filtered.items.map((item) => (item.kind === "flow_gate" ? item.gate.subjectId : null)),
        [held.requestId],
      );
      assert.equal(filtered.total, 1);
      assert.deepEqual(
        Object.fromEntries(filtered.kindCounts),
        { equity_action: 1, financial_change: 1 },
        "chips ignore the kind filter",
      );

      // My approvals, the badge and the bubble stay on the caller's own worklist.
      const mine = await withOrgContext(org.orgId, () => loadApprovals({ tab: "mine" }));
      assert.deepEqual(mine!.approvalRows, [], "nothing is assigned to the controller");
      assert.equal(mine!.tabs.find((tab) => tab.key === "mine")!.count, 0);
      const counts = await withOrgContext(org.orgId, async () => {
        const authz = state.authz as Authz;
        return inboxCounts(authz, await inboxContext(authz));
      });
      assert.equal(
        counts.approvals,
        0,
        "the badge counts the caller's worklist, not the organization's",
      );

      // A viewer restricted to another legal entity sees neither row, nor their counts.
      state.authz = controller(new Set([randomUUID()]));
      const outside = await withOrgContext(org.orgId, () => loadApprovals({ tab: "all" }));
      assert.deepEqual(outside!.approvalRows, []);
      assert.equal(outside!.total, 0);
      assert.deepEqual(
        outside!.toolbarFilters[0]!.options,
        [],
        "no kind chip reveals an out-of-scope approval",
      );
      assert.equal(outside!.gatesEmpty, true);
      state.authz = controller(new Set([org.subsidiaryId]));
      const inside = await withOrgContext(org.orgId, () => loadApprovals({ tab: "all" }));
      assert.equal(inside!.total, 2, "a viewer scoped to the entity sees both");

      // The approver the equity gate names may decide it from the same view.
      state.authz = authzFor(org.orgId, w.approverId, "equity_approver", [
        "flows.manage",
        "flows.approve",
        "equity.read",
        "equity.approve",
      ]);
      const approverView = await withOrgContext(org.orgId, () => loadApprovals({ tab: "all" }));
      assert.equal(
        approverView!.approvalRows.find((r) => r.kind === "equity_action")?.canDecide,
        true,
      );
      assert.equal(
        approverView!.approvalRows.find((r) => r.kind === "equity_action")?.canDelegate,
        true,
        "the direct assignee may delegate",
      );
      assert.equal(
        approverView!.approvalRows.find((r) => r.gateId === change.gateId)?.canDecide,
        false,
      );

      // Flow management permits reassignment; decisions remain with the configured assignee.
      state.authz = authzFor(org.orgId, adminId, "admin", ["flows.manage", "flows.approve"]);
      const adminView = await withOrgContext(org.orgId, () => loadApprovals({ tab: "all" }));
      const adminChange = adminView!.approvalRows.find((r) => r.gateId === change.gateId);
      assert.equal(
        adminChange?.canDecide,
        false,
        "an administrator cannot replace the configured approver",
      );
      assert.equal(adminChange?.canDelegate, true);

      // Without flows.manage the tab falls back to the caller's own worklist.
      state.authz = authzFor(org.orgId, controllerId, "controller", ["flows.approve"]);
      const fallback = await withOrgContext(org.orgId, () => loadApprovals({ tab: "all" }));
      assert.equal(fallback!.tabKey, "mine");
      assert.deepEqual(fallback!.approvalRows, []);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "equity subjects name their holder and figures from the recorded request",
  { skip: !DB },
  async () => {
    const w = await withBypassContext(() => setupEquityWorld());
    try {
      const { org } = w;
      const insert = (action: string, label: string, summary: Record<string, unknown>) =>
        withBypassContext(async () => {
          const id = randomUUID();
          await db.execute(sql`insert into equity_action_requests
        (id, org_id, subsidiary_id, action, subject_id, subject_label, effective_on, reason, payload, summary, status, requested_by)
        values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${action}, ${randomUUID()}, ${label}, '2026-07-15', 'Recorded for review',
                '{}'::jsonb, ${JSON.stringify(summary)}::jsonb, 'pending_approval', ${w.managerId})`);
          return id;
        });
      const repurchase = await insert("repurchase", "CS-0001", {
        securityKind: "share",
        holderName: "Founder One",
        shareClassCode: "CS",
        quantity: "250",
        amount: "1250.00",
        currency: "USD",
      });
      const amendment = await insert("class_amendment", "Class CS", {
        shareClassCode: "CS",
        quantity: "12000000",
        amount: "0.25",
      });
      const run = await insert("compensation_run", "Stock compensation", {});
      const base = await withBypassContext(
        async () =>
          (
            await db.execute<{ currency: string }>(
              sql`
      select base_currency as currency from subsidiaries where org_id = ${org.orgId} and id = ${org.subsidiaryId}`,
              "objects",
            )
          )[0]!.currency,
      );
      const text = Object.assign((key: string) => key, { has: () => false });
      const details = await withBypassContext(() =>
        resolveApprovalSubjects(
          org.orgId,
          [
            { kind: "equity_action", subjectId: repurchase },
            { kind: "equity_action", subjectId: amendment },
            { kind: "equity_action", subjectId: run },
          ],
          text,
        ),
      );
      const bought = details.get(`equity_action:${repurchase}`)!;
      assert.equal(bought.partyName, "Founder One");
      assert.equal(bought.kindLabel, "Equity action · Repurchase");
      assert.equal(bought.summary, "CS-0001");
      assert.equal(bought.quantity, "250");
      assert.equal(bought.quantitySigned, false);
      assert.equal(bought.amount, "1250.00");
      assert.equal(bought.currency, "USD", "the security's own currency");
      const amended = details.get(`equity_action:${amendment}`)!;
      assert.equal(amended.partyName, null);
      assert.equal(amended.quantity, "12000000", "authorized shares are a share count");
      assert.equal(amended.amount, "0.25");
      assert.equal(
        amended.currency,
        base,
        "a conversion price reads in the legal entity's functional currency",
      );
      const compensation = details.get(`equity_action:${run}`)!;
      assert.equal(compensation.quantity, null);
      assert.equal(compensation.amount, null);
      assert.equal(compensation.kindLabel, "Equity action · Stock compensation run");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a submitted period close is named by its fiscal period label, never the stored period name",
  { skip: !DB },
  async () => {
    const w = await withBypassContext(() => setupEquityWorld());
    try {
      const { periodDisplayLabel } = await import("@openbooks/engine/periods/period-policy");
      const period = (
        await withBypassContext(() =>
          db.execute<{
            id: string;
            fiscal_year: number;
            period_number: number;
            starts_on: string;
            ends_on: string;
            name: string;
          }>(
            sql`
      select id, fiscal_year, period_number, starts_on::text as starts_on, ends_on::text as ends_on, name from accounting_periods
       where org_id = ${w.org.orgId} and not is_adjustment order by starts_on limit 1`,
            "objects",
          ),
        )
      )[0]!;
      const blueprintId = randomUUID();
      const closeRunId = randomUUID();
      await withBypassContext(async () => {
        await grantScratchPermissions(w.org.orgId, w.managerId, ["close.run", "close.read"]);
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"continuousClose":true}'::jsonb) where id=${w.org.orgId}`);
        await grantScratchPermissions(w.org.orgId, w.approverId, ["close.approve", "close.read"]);
        await db.execute(
          sql`insert into close_blueprints (id, org_id, name) values (${blueprintId}, ${w.org.orgId}, 'Month-end close')`,
        );
        await db.execute(sql`
        insert into close_runs (id, org_id, period_id, book_id, blueprint_id, status, current_stage, target_close_date, scope, started_at, started_by, created_by, updated_by)
        values (${closeRunId}, ${w.org.orgId}, ${period.id}, ${w.org.bookId}, ${blueprintId}, 'in_progress', 'review', current_date + 30, '{}'::jsonb, now(),
                ${w.managerId}, ${w.managerId}, ${w.managerId})`);
        await seedApprovalFlow(w.org.orgId, {
          subjectKind: "close_run",
          mode: "any",
          assignees: [{ type: "user", userId: w.approverId }],
          preventSelfApproval: true,
        });
      });
      await withOrgTransaction(w.org.orgId, () =>
        routeSubjectSubmission({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subjectKind: "close_run",
          subjectId: closeRunId,
        }),
      );
      const label = periodDisplayLabel(
        {
          fiscalYear: period.fiscal_year,
          periodNumber: period.period_number,
          adjustment: false,
          startsOn: period.starts_on,
          endsOn: period.ends_on,
        },
        "en",
      );
      assert.notEqual(label, period.name, "the stored name differs from the native label");

      state.authz = authzFor(w.org.orgId, w.managerId, "equity_manager", [
        "equity.read",
        "equity.manage",
        "close.read",
        "close.run",
      ]);
      const submitted = await withOrgContext(w.org.orgId, () =>
        loadApprovals({ tab: "submitted" }),
      );
      const row = submitted!.submittedRows.find((candidate) => candidate.kind === "close_run");
      assert.ok(row, "the close's starter sees it under Submitted by me");
      assert.equal(row.documentNumber, label);
      const searched = await withOrgContext(w.org.orgId, () =>
        loadApprovals({ tab: "submitted", q: label.split(" · ")[0]! }),
      );
      assert.ok(
        searched!.submittedRows.some((candidate) => candidate.kind === "close_run"),
        "the shown label finds the row",
      );
      const byName = await withOrgContext(w.org.orgId, () =>
        loadApprovals({ tab: "submitted", q: period.name }),
      );
      assert.ok(
        byName!.submittedRows.some((candidate) => candidate.kind === "close_run"),
        "the stored name still finds the row",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
