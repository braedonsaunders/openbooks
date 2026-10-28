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
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedPostingAccount } =
  await import("@openbooks/engine/testing/fixtures");
const { loadFilings } = await import("../compliance");
const { listDunningPolicies: readDunningPolicies } = await import("../dunning-policy-management");
const { createProgram, loadStoredValueTenderAccount } =
  await import("@openbooks/engine/stored-value/accounts");
const { readAuthorityConnectionStatus } = await import("@openbooks/engine/tax");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Test",
        orgId,
        roles: [{ key: "treasury-role", name: "Treasury role" }],
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

async function setFeature(orgId: string, feature: string, enabled: boolean): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs
         set settings = jsonb_set(
           settings,
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ [feature]: enabled })}::jsonb,
           true
         )
       where id = ${orgId}
    `),
  );
}

test(
  "tax authority credential commands seal values, replay safely, and preserve organization isolation",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const context = ctxFor(org.orgId, actors.adminId, ["admin.setup.manage"]);
      const input = {
        authority: "hmrc",
        credentials: {
          clientId: "treasury-integration-client",
          clientSecret: "treasury-integration-secret",
          scope: "read:vat",
        },
        idempotencyKey: `tax-authority-save-${randomUUID()}`,
      };
      const first = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("save_tax_authority_credentials")!, context, input),
      )) as { replayed: boolean; connection: { status: string; hasCredentials: boolean } };
      assert.equal(first.replayed, false);
      assert.equal(first.connection.status, "ready");
      assert.equal(first.connection.hasCredentials, true);

      const replay = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("save_tax_authority_credentials")!, context, input),
      )) as { replayed: boolean; connection: { status: string } };
      assert.equal(replay.replayed, true);

      const native = await withOrgContext(org.orgId, () =>
        readAuthorityConnectionStatus(db, org.orgId, "hmrc"),
      );
      assert.equal(native.status, "ready");
      assert.equal(native.hasCredentials, true);
      const isolated = await withOrgContext(other.orgId, () =>
        readAuthorityConnectionStatus(db, other.orgId, "hmrc"),
      );
      assert.equal(isolated.status, "missing");
      assert.equal(isolated.hasCredentials, false);
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);

test(
  "information return commands prepare and void through native reads with safe replay",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await setFeature(org.orgId, "informationReturns", true);
      const context = ctxFor(org.orgId, actors.adminId, [
        "compliance.read",
        "compliance.manage",
        "compliance.file",
      ]);
      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool(name)!, context, input),
        );

      const input = {
        formType: "1099-NEC",
        taxYear: 2025,
        idempotencyKey: `information-return-${randomUUID()}`,
      };
      const first = (await run("prepare_information_return", input)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(first.replayed, false);
      const replay = (await run("prepare_information_return", input)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, first.id);

      const nativeRows = await withOrgContext(org.orgId, () => loadFilings(org.orgId, null));
      assert.equal(nativeRows.filter((row) => row.id === first.id).length, 1);
      assert.equal(nativeRows.find((row) => row.id === first.id)?.status, "draft");

      await run("void_information_return_filing", {
        filingId: first.id,
        reason: "Return opened in error",
        idempotencyKey: `information-return-void-${randomUUID()}`,
      });
      const afterVoid = await withOrgContext(org.orgId, () => loadFilings(org.orgId, null));
      assert.equal(afterVoid.find((row) => row.id === first.id)?.status, "void");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "stored value issuance returns its code once and reads the account natively",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await setFeature(org.orgId, "storedValue", true);
      const liabilityAccountId = await withBypassContext(() =>
        seedPostingAccount(org.orgId, "2600", "Gift card liability", "liability_current_other"),
      );
      const breakageAccountId = await withBypassContext(() =>
        seedPostingAccount(org.orgId, "4900", "Breakage income", "income_other"),
      );
      const program = await withBypassContext(() =>
        createProgram({
          orgId: org.orgId,
          name: "Application gift cards",
          kind: "gift_card",
          liabilityAccountId,
          breakageIncomeAccountId: breakageAccountId,
          breakagePolicy: "none",
          actorId: actors.adminId,
        }),
      );
      const context = ctxFor(org.orgId, actors.adminId, [
        "stored_value.manage",
        "stored_value.read",
      ]);
      const input = {
        programId: program.id,
        amount: "25.00",
        currency: "CAD",
        subsidiaryId: org.subsidiaryId,
        debitAccountId: org.accounts.bank,
        postingDate: org.date,
        idempotencyKey: `stored-value-issue-${randomUUID()}`,
      };
      const first = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("issue_stored_value")!, context, input),
      )) as { replayed: boolean; accountId: string; code: string | null };
      assert.equal(first.replayed, false);
      assert.ok(first.code);

      const replay = (await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("issue_stored_value")!, context, input),
      )) as { replayed: boolean; accountId: string; code: string | null };
      assert.equal(replay.replayed, true);
      assert.equal(replay.accountId, first.accountId);
      assert.equal(replay.code, null);

      const account = await withOrgContext(org.orgId, () =>
        loadStoredValueTenderAccount(org.orgId, first.accountId, null),
      );
      assert.ok(account);
      assert.equal(account.balanceMinor, 250000n);
      const cached = await withBypassContext(() =>
        db.execute<{ response: { code: string | null } }>(
          sql`
          select response from application_idempotency_keys
           where org_id = ${org.orgId} and actor_id = ${actors.adminId}
             and source = 'api' and operation = 'mcp.issue_stored_value'
             and idempotency_key = ${input.idempotencyKey}
        `,
          "objects",
        ),
      );
      assert.equal(cached[0]?.response.code, null);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "dunning policy commands create, update, and delete the native policy ladder",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const context = ctxFor(org.orgId, actors.adminId, ["documents.manage"]);
      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool(name)!, context, input),
        );
      const created = (await run("create_dunning_policy", {
        name: "Treasury integration reminder ladder",
        appliesToKind: "customer_invoice",
        gracePeriodDays: 4,
        minBalance: "10.00",
        isActive: true,
        stages: [
          {
            sequence: 1,
            name: "First reminder",
            offsetDays: 2,
            subjectTemplate: "Invoice reminder",
            bodyTemplate: "Please review the outstanding invoice.",
          },
        ],
        idempotencyKey: `dunning-policy-create-${randomUUID()}`,
      })) as { id: string };
      let rows = await withOrgContext(org.orgId, () => readDunningPolicies(org.orgId));
      const policy = rows.find((row) => row.id === created.id);
      assert.ok(policy);
      assert.equal(policy.minBalance, "10.0000");
      assert.equal((policy.stages as Array<{ sequence: number }>).length, 1);

      await run("update_dunning_policy", {
        policyId: created.id,
        expectedUpdatedAt: policy.updatedAt,
        name: "Treasury updated reminder ladder",
        idempotencyKey: `dunning-policy-update-${randomUUID()}`,
      });
      rows = await withOrgContext(org.orgId, () => readDunningPolicies(org.orgId));
      assert.equal(
        rows.find((row) => row.id === created.id)?.name,
        "Treasury updated reminder ladder",
      );

      await run("delete_dunning_policy", {
        policyId: created.id,
        idempotencyKey: `dunning-policy-delete-${randomUUID()}`,
      });
      rows = await withOrgContext(org.orgId, () => readDunningPolicies(org.orgId));
      assert.equal(
        rows.some((row) => row.id === created.id),
        false,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "information return commands enforce permission, feature, and organization scope",
  { skip: !DB },
  async () => {
    const first = await withBypassContext(() => createScratchOrg());
    const second = await withBypassContext(() => createScratchOrg());
    try {
      const firstActors = await withBypassContext(() => seedFlowActors(first.orgId));
      await Promise.all([
        setFeature(first.orgId, "informationReturns", true),
        setFeature(second.orgId, "informationReturns", true),
      ]);
      const full = ctxFor(first.orgId, firstActors.adminId, [
        "compliance.manage",
        "compliance.file",
      ]);
      const created = (await withOrgContext(first.orgId, () =>
        executeApplicationTool(applicationTool("prepare_information_return")!, full, {
          formType: "1099-NEC",
          taxYear: 2025,
          idempotencyKey: `information-return-cross-${randomUUID()}`,
        }),
      )) as { id: string };

      const noPermission = ctxFor(first.orgId, firstActors.adminId, []);
      await assert.rejects(
        withOrgContext(first.orgId, () =>
          executeApplicationTool(applicationTool("prepare_information_return")!, noPermission, {
            formType: "1099-MISC",
            taxYear: 2025,
            idempotencyKey: `information-return-permission-${randomUUID()}`,
          }),
        ),
        /forbidden/,
      );

      await setFeature(first.orgId, "informationReturns", false);
      try {
        await assert.rejects(
          withOrgContext(first.orgId, () =>
            executeApplicationTool(applicationTool("prepare_information_return")!, full, {
              formType: "1099-MISC",
              taxYear: 2025,
              idempotencyKey: `information-return-feature-${randomUUID()}`,
            }),
          ),
          /informationReturns not found/,
        );
      } finally {
        await setFeature(first.orgId, "informationReturns", true);
      }

      const otherOrg = ctxFor(second.orgId, firstActors.adminId, ["compliance.read"]);
      const otherOrgFilings = (await withOrgContext(second.orgId, () =>
        executeApplicationTool(applicationTool("list_information_return_filings")!, otherOrg, {}),
      )) as { filings: Array<{ id: string }> };
      assert.equal(
        otherOrgFilings.filings.some((filing) => filing.id === created.id),
        false,
      );
    } finally {
      await dropScratchOrg(first.orgId);
      await dropScratchOrg(second.orgId);
    }
  },
);
