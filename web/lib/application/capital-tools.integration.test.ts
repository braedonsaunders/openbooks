import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { provisionFundAccounting } = await import("@openbooks/engine/testing/nonprofit/provision");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
const { executeAssistantTool } = await import("../assistant/registry.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function contextFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Capital Test",
        orgId,
        roles: [{ key: "capital-role", name: "Capital role" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function setFeatures(orgId: string, features: Record<string, boolean>): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb), '{features}',
           coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb,
           true
         )
       where id = ${orgId}
       returning id
    `),
  );
}

function leaseInput(
  org: {
    subsidiaryId: string;
    accounts: { invAsset: string; deferred: string; cogs: string; bank: string };
  },
  key: string,
  number: string,
) {
  return {
    subsidiaryId: org.subsidiaryId,
    leaseNumber: number,
    commencementOn: "2026-07-01",
    termPeriods: 12,
    paymentFrequency: "monthly",
    paymentTiming: "arrears",
    paymentAmount: "1000.0000",
    annualDiscountRatePercent: "6",
    classificationInputs: {},
    accounts: {
      rouAsset: org.accounts.invAsset!,
      leaseLiability: org.accounts.deferred!,
      interestExpense: org.accounts.cogs!,
      amortizationExpense: org.accounts.cogs!,
      leaseExpense: org.accounts.cogs!,
      payment: org.accounts.bank!,
    },
    idempotencyKey: key,
  };
}

test("capital commands create and replay lease and fund workflows", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    await setFeatures(org.orgId, { fixedAssets: true, nonprofit: true, fundAccounting: true });
    const context = contextFor(org.orgId, actors.adminId, [
      "assets.manage",
      "assets.read",
      "funds.manage",
      "funds.read",
      "admin.setup.manage",
    ]);
    const run = (name: string, input: Record<string, unknown>) =>
      withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool(name)!, context, input),
      );

    const lease = leaseInput(org, "capital-lease-0001", `L-${randomUUID().slice(0, 8)}`);
    const createdLease = await run("create_lease_agreement", lease);
    assert.equal(createdLease.replayed, false);
    const leaseId = String(createdLease.leaseId);
    const replay = await run("create_lease_agreement", lease);
    assert.equal(replay.replayed, true);
    assert.equal(replay.leaseId, leaseId);
    const leaseRead = await withOrgContext(org.orgId, () =>
      executeAssistantTool(context.authz, "get_lease_agreement", { id: leaseId }),
    );
    assert.equal(leaseRead.ok, true);
    if (!leaseRead.ok) throw new Error(leaseRead.error);
    assert.equal((leaseRead.data as { lease: { status: string } }).lease.status, "draft");

    await withBypassContext(() =>
      provisionFundAccounting({
        orgId: org.orgId,
        actorId: actors.adminId,
        defaultFund: { code: "OPERATING", name: "Operating Fund" },
        classifications: {
          OPERATING: { kind: "operating", restrictionClass: "unrestricted" },
        },
      }),
    );
    const fundInput = {
      action: "create",
      code: `CAP-${randomUUID().slice(0, 8)}`,
      name: "Capital Project Fund",
      kind: "restricted",
      restrictionClass: "donor_restricted",
      budgetaryControl: "advisory",
      idempotencyKey: "capital-fund-0001",
    };
    const createdFund = await run("create_fund", fundInput);
    assert.equal(createdFund.replayed, false);
    const fundReplay = await run("create_fund", fundInput);
    assert.equal(fundReplay.replayed, true);
    const funds = await run("list_funds", { search: fundInput.code });
    const fundRows = funds.funds as Array<{ id: string; code: string }>;
    assert.equal(fundRows.length, 1);
    assert.equal(fundRows[0]!.code, fundInput.code);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "capital commands enforce permission, feature and organization boundaries",
  { skip: !DB },
  async () => {
    const first = await withBypassContext(() => createScratchOrg());
    const second = await withBypassContext(() => createScratchOrg());
    try {
      const firstActors = await withBypassContext(() => seedFlowActors(first.orgId));
      const secondActors = await withBypassContext(() => seedFlowActors(second.orgId));
      await setFeatures(first.orgId, { fixedAssets: true });
      await setFeatures(second.orgId, { fixedAssets: true });
      const full = contextFor(first.orgId, firstActors.adminId, ["assets.manage", "assets.read"]);
      const firstLease = leaseInput(first, "capital-lease-0002", `L-${randomUUID().slice(0, 8)}`);
      const create = applicationTool("create_lease_agreement")!;

      await assert.rejects(
        withOrgContext(first.orgId, () =>
          executeApplicationTool(create, contextFor(first.orgId, firstActors.adminId, []), {
            ...firstLease,
            idempotencyKey: "capital-lease-denied",
          }),
        ),
        /forbidden/,
      );
      const created = await withOrgContext(first.orgId, () =>
        executeApplicationTool(create, full, firstLease),
      );

      await setFeatures(first.orgId, { fixedAssets: false });
      try {
        await assert.rejects(
          withOrgContext(first.orgId, () =>
            executeApplicationTool(create, full, {
              ...leaseInput(first, "capital-lease-feature", `L-${randomUUID().slice(0, 8)}`),
            }),
          ),
          /fixedAssets|fixed assets|not found/i,
        );
      } finally {
        await setFeatures(first.orgId, { fixedAssets: true });
      }

      const otherContext = contextFor(second.orgId, secondActors.adminId, ["assets.manage"]);
      await assert.rejects(
        withOrgContext(second.orgId, () =>
          executeApplicationTool(applicationTool("commence_lease")!, otherContext, {
            leaseId: created.leaseId,
            idempotencyKey: "capital-lease-cross-org",
          }),
        ),
      );
    } finally {
      await dropScratchOrg(first.orgId);
      await dropScratchOrg(second.orgId);
    }
  },
);
