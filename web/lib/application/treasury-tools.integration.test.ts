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
const { seedApprovedBankAccountFixture } = await import("@openbooks/engine/testing/bank-accounts");
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
  const featureJson = JSON.stringify({ [feature]: enabled });
  const updated = await withBypassContext(() =>
    db.execute(
      sql`
        update orgs
           set settings = jsonb_set(
             settings,
             '{features}',
             coalesce(settings->'features', '{}'::jsonb) || ${featureJson}::jsonb,
             true
           )
         where id = ${orgId}
         returning id
      `,
      "objects",
    ),
  );
  assert.equal(updated.length, 1, "the feature update must match the leased organization");
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
  "payment operation configuration commands create, update, replay, and read scoped records",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const context = ctxFor(org.orgId, actors.adminId, ["admin.setup.manage"]);
      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool(name)!, context, input),
        );
      const formatInput = {
        code: `TOOL-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Application test payment format",
        formatterScript: "return rows;",
        idempotencyKey: `payment-format-create-${randomUUID()}`,
      };
      const format = (await run("create_payment_format", formatInput)) as {
        replayed: boolean;
        id: string;
        record: Record<string, unknown>;
      };
      assert.equal(format.replayed, false);
      assert.equal(format.record.name, formatInput.name);
      const replay = (await run("create_payment_format", formatInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, format.id);
      const formatCount = await withOrgContext(org.orgId, () =>
        db.execute<{ count: string }>(
          sql`select count(*)::text as count from payment_formats where org_id = ${org.orgId} and id = ${format.id}`,
          "objects",
        ),
      );
      assert.equal(formatCount[0]?.count, "1");

      const update = (await run("update_payment_format", {
        id: format.id,
        name: "Updated application payment format",
        idempotencyKey: `payment-format-update-${randomUUID()}`,
      })) as { record: Record<string, unknown> };
      assert.equal(update.record.name, "Updated application payment format");

      const partyBankAccountId = await seedApprovedBankAccountFixture({
        orgId: org.orgId,
        actorId: actors.adminId,
        partyId: org.customerId,
        bankName: "Application test bank",
        country: "CA",
        currency: "CAD",
        routing: {},
        lastFour: "4242",
      });
      const partySetup = (await run("get_party_payment_setup", {
        partyId: org.customerId,
      })) as { bankAccounts: Array<{ id: string }> };
      assert.ok(partySetup.bankAccounts.some((account) => account.id === partyBankAccountId));

      const profile = (await run("create_payment_bank_profile", {
        name: "Application test bank profile",
        bankAccountId: org.accounts.bank,
        paymentFormatId: format.id,
        subsidiaryId: org.subsidiaryId,
        idempotencyKey: `payment-profile-create-${randomUUID()}`,
      })) as { id: string; record: Record<string, unknown> };
      assert.equal(profile.record.name, "Application test bank profile");
      assert.equal(profile.record.has_secrets, false);
      assert.equal("originator_secrets_encrypted" in profile.record, false);

      const schedule = (await run("create_payment_schedule", {
        name: "Application test schedule",
        paymentBankProfileId: profile.id,
        cron: "0 0 * * *",
        timezone: "UTC",
        idempotencyKey: `payment-schedule-create-${randomUUID()}`,
      })) as { id: string; record: Record<string, unknown> };
      assert.equal(schedule.record.profile_name, "Application test bank profile");
      const updatedSchedule = (await run("update_payment_schedule", {
        id: schedule.id,
        name: "Updated application schedule",
        idempotencyKey: `payment-schedule-update-${randomUUID()}`,
      })) as { record: Record<string, unknown> };
      assert.equal(updatedSchedule.record.name, "Updated application schedule");

      const mandate = (await run("create_payment_mandate", {
        partyId: org.customerId,
        partyBankAccountId,
        mandateReference: `TOOL-${randomUUID().slice(0, 8)}`,
        scheme: "custom",
        signedOn: org.date,
        idempotencyKey: `payment-mandate-create-${randomUUID()}`,
      })) as { id: string; status: string; record: Record<string, unknown> };
      assert.equal(mandate.status, "pending");
      const updatedMandate = (await run("update_payment_mandate", {
        id: mandate.id,
        status: "active",
        idempotencyKey: `payment-mandate-update-${randomUUID()}`,
      })) as { status: string };
      assert.equal(updatedMandate.status, "active");

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          executeApplicationTool(
            applicationTool("create_payment_format")!,
            ctxFor(org.orgId, actors.adminId, []),
            {
              code: "DENIED-TOOL",
              name: "Denied format",
              formatterScript: "return rows;",
              idempotencyKey: `payment-format-denied-${randomUUID()}`,
            },
          ),
        ),
        /forbidden/,
      );

      await setFeature(org.orgId, "multiCurrency", false);
      await assert.rejects(
        run("create_payment_format", {
          code: "CURRENCY-OFF-TOOL",
          name: "Currency restricted format",
          formatterScript: "return rows;",
          currency: "USD",
          idempotencyKey: `payment-format-feature-${randomUUID()}`,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /not found/);
          assert.equal((error as Error & { status?: number }).status, 404);
          return true;
        },
      );
      await setFeature(org.orgId, "multiCurrency", true);

      const otherContext = ctxFor(other.orgId, actors.adminId, ["admin.setup.manage"]);
      const otherFormats = (await withOrgContext(other.orgId, () =>
        executeApplicationTool(applicationTool("list_payment_operation_configs")!, otherContext, {
          resource: "formats",
        }),
      )) as { rows: Array<{ id: string }> };
      assert.equal(
        otherFormats.rows.some((row) => row.id === format.id),
        false,
      );
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
