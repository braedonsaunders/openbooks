import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules";
import { resolveEngineSpecifier } from "../../../testing/engine-resolve-hooks";

// Approvals worklist paging — the loader must page in SQL (limit/offset per
// gate query) instead of fetching every pending gate in the org. Seeds more
// gates than one page holds and asserts the page returns a window plus a
// total, not everything.
const stateKey = Symbol.for("openbooks.approvals-paging-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.approvals-paging-test')]
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
      return { url: "mock:approvals-paging-authz", shortCircuit: true };
    }
    if (specifier === "@/lib/money-server" && context.parentURL?.includes("/inbox/")) {
      return { url: "mock:approvals-paging-money", shortCircuit: true };
    }
    const engineUrl = resolveEngineSpecifier(specifier);
    if (engineUrl) return nextResolve(engineUrl, context);
    if (context.parentURL?.startsWith("mock:")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:approvals-paging-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:approvals-paging-money") {
      return { format: "module", source: mockMoney, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { loadApprovals } = await import("./view.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/testing/fixtures").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;
const GATES = 60;
const DOCS = 3;
const TOTAL = GATES + DOCS;

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId,
      email: `${userId}@test`,
      name: "Paging Approver",
      orgId,
      roles: [{ key: "approver", name: "approver" }],
      envKind: "sandbox",
      productionOrgId: orgId,
      isSuperAdmin: false,
      homeUserId: userId,
      homeOrgId: orgId,
    },
    permissions: new Set(["flows.approve", "ap.approve", "ar.approve", "time.approve"]),
    allowedSubsidiaryIds: null,
  };
}

const { seedFlowActors, seedApprovalFlow, seedDraftDocument, grantScratchPermissions } =
  await import("@openbooks/engine/testing/fixtures");
const { submitForApproval } = await import("@openbooks/engine/flows/submit");
const { routeSubjectSubmission } = await import("@openbooks/engine/flows/submission-policy");
const { withOrgTransaction } = await import("@openbooks/engine/platform/db");
const { installEngineSeams } = await import("@openbooks/engine/composition/install");
installEngineSeams();

async function seedPagingOrg(
  gateCount: number,
  docCount: number,
): Promise<{ org: ScratchOrg; approver: string; submitter: string }> {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actors = await withBypass(() => seedFlowActors(org.orgId));
    await withBypass(async () => {
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"flows":true,"timeTracking":true}'::jsonb) where id=${org.orgId}`,
      );
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["time.approve", "ar.approve"]);
      for (const subjectKind of ["timesheet_week", "customer_invoice"])
        await seedApprovalFlow(org.orgId, {
          subjectKind,
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "all",
        });
    });
    for (let i = 0; i < gateCount; i++) {
      const employee = randomUUID(),
        id = randomUUID();
      await withBypass(async () => {
        await db.execute(
          sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values(${employee},${org.orgId},'person',${`Paging worker ${i}`},${org.subsidiaryId},true,'{}'::jsonb)`,
        );
        await db.execute(
          sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_by,submitted_at,created_by,updated_by) values(${id},${org.orgId},${employee},'2026-07-12','submitted',${actors.submitterId},now(),${actors.submitterId},${actors.submitterId})`,
        );
      });
      await withOrgTransaction(org.orgId, () =>
        routeSubjectSubmission({
          orgId: org.orgId,
          actorId: actors.submitterId,
          subjectKind: "timesheet_week",
          subjectId: id,
        }),
      );
    }
    for (let i = 0; i < docCount; i++) {
      const id = await withBypass(() =>
        seedDraftDocument(org.orgId, {
          kind: "customer_invoice",
          createdBy: actors.submitterId,
          number: `PAGING-${i}`,
        }),
      );
      await withOrgContext(org.orgId, () =>
        submitForApproval("customer_invoice", id, actors.submitterId),
      );
    }
    return { org, approver: actors.approver1Id, submitter: actors.submitterId };
  } catch (error) {
    await withBypass(() => dropScratchOrg(org.orgId));
    throw error;
  }
}

test("approvals mine tab pages in SQL instead of returning every gate", { skip: !DB }, async () => {
  const { org, approver } = await seedPagingOrg(GATES, DOCS);
  try {
    state.authz = authzFor(org.orgId, approver);
    const first = await withOrgContext(org.orgId, () => loadApprovals({}));
    assert.ok(first, "loader returns data");
    assert.equal(first!.total, TOTAL, "loader reports the full worklist total, not the window");
    assert.equal(first!.approvalRows.length, 25, "page one holds one page, not every gate");

    const second = await withOrgContext(org.orgId, () => loadApprovals({ page: "2" }));
    assert.ok(second, "loader returns data");
    assert.equal(second!.total, TOTAL, "total is stable across pages");
    const firstKeys = new Set(first!.approvalRows.map((r) => r.key));
    for (const row of second!.approvalRows) {
      assert.ok(!firstKeys.has(row.key), `page two repeats a page-one row (${row.key})`);
    }
    assert.equal(
      first!.approvalRows.length +
        second!.approvalRows.length +
        (await withOrgContext(org.orgId, () => loadApprovals({ page: "3" })))!.approvalRows.length,
      TOTAL,
      "pages partition the whole worklist",
    );

    const mineTab = first!.tabs.find((t) => t.key === "mine");
    assert.equal(mineTab?.count, TOTAL, "mine count bubble ties the total by construction");

    const clamped = await withOrgContext(org.orgId, () => loadApprovals({ perPage: "1000" }));
    assert.ok(
      (clamped!.approvalRows.length as number) <= 50,
      "perPage cannot exceed one bulk request",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("approvals submitted tab pages native submission runs", { skip: !DB }, async () => {
  const { org, submitter } = await seedPagingOrg(0, 3);
  try {
    state.authz = authzFor(org.orgId, submitter);
    const data = await withOrgContext(org.orgId, () => loadApprovals({ tab: "submitted" }));
    assert.ok(data);
    assert.equal(data.submittedTotal, 3);
    assert.equal(data.submittedRows.length, 3);
    const empty = await withOrgContext(org.orgId, () =>
      loadApprovals({ tab: "submitted", page: "2" }),
    );
    assert.equal(empty?.submittedTotal, 3);
    assert.equal(empty?.submittedRows.length, 0);
  } finally {
    state.authz = null;
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("paged worklist agrees with the full worklist the tile counts", { skip: !DB }, async () => {
  // The center and dashboard use the same native gate predicates.
  // Walking every page must reproduce
  // the full set, the total, and the kind chips exactly.
  const { approvalWorklistForAuthz, approvalWorklistPageForAuthz } =
    await import("@/lib/application/approvals");
  type Full = Awaited<ReturnType<typeof approvalWorklistForAuthz>>;
  const { org, approver } = await seedPagingOrg(30, 4);
  try {
    const authz = authzFor(org.orgId, approver);
    const full = await withOrgContext(org.orgId, () => approvalWorklistForAuthz(authz));
    const seen: Full = [];
    let total = -1;
    let chips = new Map<string, number>();
    for (let pageNum = 1; ; pageNum++) {
      const window = await withOrgContext(org.orgId, () =>
        approvalWorklistPageForAuthz(authz, { limit: 10, offset: (pageNum - 1) * 10 }),
      );
      if (pageNum === 1) {
        total = window.total;
        chips = window.kindCounts;
      } else {
        assert.equal(window.total, total, "total is stable across pages");
      }
      seen.push(...window.items);
      if (window.items.length < 10) break;
      assert.ok(pageNum < 10, "paging terminates");
    }
    const keyOf = (item: Full[number]): string => `flow_gate:${item.id}`;
    assert.deepEqual(
      new Set(seen.map(keyOf)),
      new Set(full.map(keyOf)),
      "pages accumulate exactly the full set",
    );
    assert.equal(total, full.length, "paged total ties the full count");
    const expectedChips = new Map<string, number>();
    for (const item of full) {
      const kind = item.document?.kind ?? item.subjectKind;
      expectedChips.set(kind, (expectedChips.get(kind) ?? 0) + 1);
    }
    assert.deepEqual(
      Object.fromEntries(chips),
      Object.fromEntries(expectedChips),
      "kind chips tie the full set",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test(
  "a submitted week without native routing evidence is not an alternate approval",
  { skip: !DB },
  async () => {
    const { org, approver, submitter } = await seedPagingOrg(1, 0);
    try {
      await withBypass(async () => {
        const employee = randomUUID();
        await db.execute(
          sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values(${employee},${org.orgId},'person','Unrouted worker',${org.subsidiaryId},true,'{}'::jsonb)`,
        );
        await db.execute(
          sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,submitted_by,submitted_at,created_by,updated_by) values(${randomUUID()},${org.orgId},${employee},'2026-07-19','submitted',${submitter},now(),${submitter},${submitter})`,
        );
      });
      state.authz = authzFor(org.orgId, approver);
      const data = await withOrgContext(org.orgId, () => loadApprovals({}));
      assert.ok(data);
      assert.equal(data.total, 1);
      assert.equal(data.unfilteredTotal, 1);
      assert.equal(data.approvalRows.length, 1);
      assert.equal(data.tabs.find((tab) => tab.key === "mine")?.count, 1);
    } finally {
      state.authz = null;
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
