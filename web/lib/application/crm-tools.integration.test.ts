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
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
const { loadActivity, loadCrmAccount, loadOpportunity } = await import("../crm");
const { executeAssistantTool } = await import("../assistant/registry");
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
        roles: [{ key: "crm-service-role", name: "CRM and service role" }],
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

async function setServiceEnabled(orgId: string, enabled: boolean): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb),
        '{features}',
        coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({
          hrm: true,
          hrmShiftPlanning: true,
          serviceDispatch: enabled,
        })}::jsonb,
        true
      ) where id = ${orgId}
    `),
  );
}

async function setCrmEnabled(orgId: string, enabled: boolean): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      update orgs set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb),
        '{features}',
        coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ crm: enabled })}::jsonb,
        true
      ) where id = ${orgId}
    `),
  );
}

async function activateScratchCustomer(orgId: string, partyId: string): Promise<void> {
  const rows = await withBypassContext(() =>
    db.execute(
      sql`
      insert into customer_roles (org_id, party_id, is_active)
      values (${orgId}, ${partyId}, true)
      returning party_id
    `,
      "objects",
    ),
  );
  assert.equal(rows.length, 1, "scratch customer role is available to service workflows");
}

test(
  "CRM, party relationships and service requests use native reads and replay safely",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await setServiceEnabled(org.orgId, true);
      await setCrmEnabled(org.orgId, true);
      await activateScratchCustomer(org.orgId, org.customerId);
      const permissions = [
        "crm.accounts.create",
        "crm.accounts.manage",
        "crm.activities.manage",
        "crm.forecasts.manage",
        "crm.forecasts.read",
        "crm.opportunities.manage",
        "crm.setup.manage",
        "assistant.use",
        "parties.read",
        "parties.manage",
        "service.manage",
        "service.read",
      ];
      const ctx = ctxFor(org.orgId, actors.adminId, permissions);
      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () => executeApplicationTool(applicationTool(name)!, ctx, input));

      const lead = (await run("create_crm_lead", {
        lifecycleStage: "lead",
        idempotencyKey: "crm-lead-create-0001",
      })) as { replayed: boolean; partyId: string };
      assert.equal(lead.replayed, false);
      const leadReplay = (await run("create_crm_lead", {
        lifecycleStage: "lead",
        idempotencyKey: "crm-lead-create-0001",
      })) as { replayed: boolean; partyId: string };
      assert.equal(leadReplay.replayed, true);
      assert.equal(leadReplay.partyId, lead.partyId);

      const leadBefore = await withOrgContext(org.orgId, () =>
        loadCrmAccount(lead.partyId, org.orgId, null),
      );
      const leadProfile = leadBefore?.profile as Record<string, unknown>;
      assert.equal(leadProfile.lifecycle_stage, "lead");
      await run("convert_crm_lead", {
        partyId: lead.partyId,
        reason: "Qualified for customer service",
        expectedUpdatedAt: String(leadProfile.updated_at),
        idempotencyKey: "crm-lead-convert-0001",
      });
      const converted = await withOrgContext(org.orgId, () =>
        loadCrmAccount(lead.partyId, org.orgId, null),
      );
      assert.equal((converted?.profile as Record<string, unknown>).lifecycle_stage, "customer");
      const accountUpdateInput = {
        partyId: lead.partyId,
        expectedUpdatedAt: String((converted?.profile as Record<string, unknown>).updated_at),
        industry: "Education",
        idempotencyKey: "crm-account-update-0001",
      };
      const accountUpdate = (await run("update_crm_account", accountUpdateInput)) as {
        replayed: boolean;
      };
      assert.equal(accountUpdate.replayed, false);
      const accountUpdateReplay = (await run("update_crm_account", accountUpdateInput)) as {
        replayed: boolean;
      };
      assert.equal(accountUpdateReplay.replayed, true);
      const accountAfterUpdate = await withOrgContext(org.orgId, () =>
        loadCrmAccount(lead.partyId, org.orgId, null),
      );
      assert.equal((accountAfterUpdate?.profile as Record<string, unknown>).industry, "Education");

      const opportunity = (await run("create_crm_opportunity", {
        partyId: org.customerId,
        idempotencyKey: "crm-opportunity-create-0001",
      })) as { opportunityId: string };
      const opportunityBefore = await withOrgContext(org.orgId, () =>
        loadOpportunity(opportunity.opportunityId, org.orgId, null),
      );
      assert.ok(opportunityBefore);
      const opportunityHead = opportunityBefore.opportunity as Record<string, unknown>;
      const stageInput = {
        opportunityId: opportunity.opportunityId,
        statusId: String(opportunityHead.status_id),
        expectedUpdatedAt: String(opportunityHead.updated_at),
        idempotencyKey: "crm-opportunity-stage-0001",
      };
      const moved = (await run("move_crm_opportunity_stage", stageInput)) as {
        replayed: boolean;
      };
      assert.equal(moved.replayed, false);
      const movedReplay = (await run("move_crm_opportunity_stage", stageInput)) as {
        replayed: boolean;
      };
      assert.equal(movedReplay.replayed, true);
      const opportunityAfter = await withOrgContext(org.orgId, () =>
        loadOpportunity(opportunity.opportunityId, org.orgId, null),
      );
      assert.equal(
        (opportunityAfter?.opportunity as Record<string, unknown>).status_id,
        opportunityHead.status_id,
      );
      await run("delete_crm_opportunity", {
        opportunityId: opportunity.opportunityId,
        idempotencyKey: "crm-opportunity-delete-0001",
      });
      assert.equal(
        await withOrgContext(org.orgId, () =>
          loadOpportunity(opportunity.opportunityId, org.orgId, null),
        ),
        null,
      );

      const activity = (await run("create_crm_activity", {
        kind: "task",
        subjectKind: "account",
        subjectId: lead.partyId,
        idempotencyKey: "crm-task-create-0001",
      })) as { activityId: string };
      const activityBefore = await withOrgContext(org.orgId, () =>
        loadActivity(activity.activityId, org.orgId, null),
      );
      assert.ok(activityBefore);
      const activityUpdateInput = {
        activityId: activity.activityId,
        expectedUpdatedAt: String((activityBefore.activity as Record<string, unknown>).updated_at),
        status: "completed",
        idempotencyKey: "crm-task-complete-0001",
      };
      const completedTask = (await run("update_crm_activity", activityUpdateInput)) as {
        replayed: boolean;
      };
      assert.equal(completedTask.replayed, false);
      const completedTaskReplay = (await run("update_crm_activity", activityUpdateInput)) as {
        replayed: boolean;
      };
      assert.equal(completedTaskReplay.replayed, true);
      const activityAfter = await withOrgContext(org.orgId, () =>
        loadActivity(activity.activityId, org.orgId, null),
      );
      assert.equal((activityAfter?.activity as Record<string, unknown>).status, "completed");
      await run("delete_crm_activity", {
        activityId: activity.activityId,
        idempotencyKey: "crm-task-delete-0001",
      });
      assert.equal(
        await withOrgContext(org.orgId, () => loadActivity(activity.activityId, org.orgId, null)),
        null,
      );

      const forecastInput = {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        snapshotKind: "calculated",
        idempotencyKey: "crm-forecast-snapshot-0001",
      };
      const snapshot = (await run("create_crm_forecast_snapshot", forecastInput)) as {
        replayed: boolean;
        ids: string[];
      };
      assert.equal(snapshot.replayed, false);
      const snapshotReplay = (await run("create_crm_forecast_snapshot", forecastInput)) as {
        replayed: boolean;
        ids: string[];
      };
      assert.equal(snapshotReplay.replayed, true);
      assert.deepEqual(snapshotReplay.ids, snapshot.ids);
      const forecastRead = await withOrgContext(org.orgId, () =>
        executeAssistantTool(ctx.authz, "crm_forecast", {
          periodStart: forecastInput.periodStart,
          periodEnd: forecastInput.periodEnd,
        }),
      );
      assert.equal(forecastRead.ok, true, JSON.stringify(forecastRead));
      assert.ok(forecastRead.ok);
      const snapshots = (forecastRead.data as { snapshots: Array<Record<string, unknown>> })
        .snapshots;
      assert.ok(snapshots.some((row) => snapshot.ids.includes(String(row.id))));

      const sourceInput = {
        name: "Website referral",
        isActive: true,
        idempotencyKey: "crm-lead-source-create-0001",
      };
      const source = (await run("save_crm_lead_source", sourceInput)) as { replayed: boolean };
      assert.equal(source.replayed, false);
      const sourceReplay = (await run("save_crm_lead_source", sourceInput)) as {
        replayed: boolean;
      };
      assert.equal(sourceReplay.replayed, true);
      const setup = (await run("get_crm_pipeline_setup", {})) as {
        sources: Array<{ name: string }>;
      };
      assert.ok(setup.sources.some((row) => row.name === "Website referral"));

      const partyRead = (await run("get_party_relationships", {
        partyId: org.customerId,
      })) as { revision: string };
      const relationshipInput = {
        partyId: org.customerId,
        expectedUpdatedAt: partyRead.revision,
        addresses: [
          {
            label: "Service",
            line1: "12 Main Street",
            city: "Toronto",
            country: "CA",
            isDefaultBilling: true,
          },
        ],
        contacts: [
          {
            firstName: "Morgan",
            lastName: "Customer",
            email: "morgan@example.test",
            role: "service",
            isPrimary: true,
          },
        ],
        idempotencyKey: "party-relations-update-0001",
      };
      const relations = (await run("replace_party_relationships", relationshipInput)) as {
        replayed: boolean;
      };
      assert.equal(relations.replayed, false);
      const relationsReplay = (await run("replace_party_relationships", relationshipInput)) as {
        replayed: boolean;
      };
      assert.equal(relationsReplay.replayed, true);
      const partyAfter = (await run("get_party_relationships", {
        partyId: org.customerId,
      })) as { addresses: Array<{ line1: string }>; contacts: Array<{ email: string }> };
      assert.equal(partyAfter.addresses[0]?.line1, "12 Main Street");
      assert.equal(partyAfter.contacts[0]?.email, "morgan@example.test");

      const bankCreate = (await run("create_party_bank_account", {
        partyId: org.customerId,
        bankName: "North Bank",
        country: "CA",
        accountNumber: "000012345678",
        idempotencyKey: "party-bank-create-0001",
      })) as { replayed: boolean; bankAccountId: string };
      assert.equal(bankCreate.replayed, false);
      const bankRead = (await run("get_party_bank_accounts", {
        partyId: org.customerId,
      })) as { bankAccounts: Array<Record<string, unknown>> };
      const bankRow = bankRead.bankAccounts.find((row) => row.id === bankCreate.bankAccountId);
      assert.ok(bankRow);
      assert.equal(bankRow.account_last_four, "5678");
      assert.equal(JSON.stringify(bankRead).includes("000012345678"), false);

      const bankUpdateInput = {
        partyId: org.customerId,
        accountId: bankCreate.bankAccountId,
        expectedUpdatedAt: String(bankRow.updated_at),
        bankName: "North Bank Commercial",
        changeReason: "Corrected account label",
        idempotencyKey: "party-bank-update-0001",
      };
      const bankUpdate = (await run("update_party_bank_account", bankUpdateInput)) as {
        replayed: boolean;
      };
      assert.equal(bankUpdate.replayed, false);
      const bankUpdateReplay = (await run("update_party_bank_account", bankUpdateInput)) as {
        replayed: boolean;
      };
      assert.equal(bankUpdateReplay.replayed, true);
      const pendingFixture = await withOrgContext(org.orgId, () =>
        db.execute(sql`
          update party_bank_accounts
             set approval_status = 'pending', is_active = false,
                 approved_at = null, approved_by = null, updated_at = now(), updated_by = ${actors.adminId}
           where id = ${bankCreate.bankAccountId} and party_id = ${org.customerId} and org_id = ${org.orgId}
        `),
      );
      assert.equal(pendingFixture.rowCount, 1);
      const pendingRead = (await run("get_party_bank_accounts", {
        partyId: org.customerId,
      })) as { bankAccounts: Array<Record<string, unknown>> };
      const pendingRow = pendingRead.bankAccounts.find(
        (row) => row.id === bankCreate.bankAccountId,
      );
      assert.equal(pendingRow?.approval_status, "pending");
      const submitted = (await run("submit_party_bank_account_for_approval", {
        partyId: org.customerId,
        accountId: bankCreate.bankAccountId,
        idempotencyKey: "party-bank-submit-0001",
      })) as { replayed: boolean };
      assert.equal(submitted.replayed, false);
      const submittedReplay = (await run("submit_party_bank_account_for_approval", {
        partyId: org.customerId,
        accountId: bankCreate.bankAccountId,
        idempotencyKey: "party-bank-submit-0001",
      })) as { replayed: boolean };
      assert.equal(submittedReplay.replayed, true);
      const approvedRead = (await run("get_party_bank_accounts", {
        partyId: org.customerId,
      })) as { bankAccounts: Array<Record<string, unknown>> };
      const approvedRow = approvedRead.bankAccounts.find(
        (row) => row.id === bankCreate.bankAccountId,
      );
      assert.equal(approvedRow?.approval_status, "approved");
      assert.equal(approvedRow?.is_active, true);
      await run("retire_party_bank_account", {
        partyId: org.customerId,
        accountId: bankCreate.bankAccountId,
        expectedUpdatedAt: String(approvedRow?.updated_at),
        retirementReason: "Account closed by customer",
        idempotencyKey: "party-bank-retire-0001",
      });
      const retiredRead = (await run("get_party_bank_accounts", {
        partyId: org.customerId,
      })) as { bankAccounts: Array<Record<string, unknown>> };
      const retiredRow = retiredRead.bankAccounts.find(
        (row) => row.id === bankCreate.bankAccountId,
      );
      assert.ok(retiredRow?.retired_at);

      const requestId = randomUUID();
      const requestInput = {
        id: requestId,
        customerPartyId: org.customerId,
        serviceAddressId: null,
        contactId: null,
        subsidiaryId: org.subsidiaryId,
        title: "No heat in north office",
        description: "The heating unit is not running.",
        priority: "high",
        preferredOn: null,
        preferredTime: "any",
        idempotencyKey: "service-request-create-0001",
      };
      const created = (await run("create_service_request", requestInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(created.replayed, false);
      const replayed = (await run("create_service_request", requestInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.id, requestId);
      const nativeRead = (await run("get_service_request", { requestId })) as {
        request: { id: string; title: string };
      };
      assert.equal(nativeRead.request.id, requestId);
      assert.equal(nativeRead.request.title, "No heat in north office");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "CRM and service commands enforce permissions, feature state and organization scope",
  { skip: !DB },
  async () => {
    const first = await withBypassContext(() => createScratchOrg());
    const second = await withBypassContext(() => createScratchOrg());
    try {
      const firstActors = await withBypassContext(() => seedFlowActors(first.orgId));
      const secondActors = await withBypassContext(() => seedFlowActors(second.orgId));
      await setServiceEnabled(first.orgId, true);
      await setServiceEnabled(second.orgId, true);
      await setCrmEnabled(first.orgId, true);
      await setCrmEnabled(second.orgId, true);
      await activateScratchCustomer(first.orgId, first.customerId);
      await activateScratchCustomer(second.orgId, second.customerId);
      const full = ctxFor(first.orgId, firstActors.adminId, ["service.manage", "service.read"]);
      const input = {
        id: randomUUID(),
        customerPartyId: first.customerId,
        serviceAddressId: null,
        contactId: null,
        subsidiaryId: first.subsidiaryId,
        title: "Permission test request",
        priority: "normal",
        idempotencyKey: "service-request-permission-0001",
      };
      await assert.rejects(
        withOrgContext(first.orgId, () =>
          executeApplicationTool(
            applicationTool("create_service_request")!,
            ctxFor(first.orgId, firstActors.adminId, []),
            input,
          ),
        ),
        /forbidden/,
      );

      const created = (await withOrgContext(first.orgId, () =>
        executeApplicationTool(applicationTool("create_service_request")!, full, input),
      )) as { id: string };
      const crmStageTool = applicationTool("move_crm_opportunity_stage")!;
      const crmWithoutPermissions = ctxFor(first.orgId, firstActors.adminId, []);
      assert.equal(crmStageTool.visibleTo(crmWithoutPermissions.authz), false);
      assert.equal(
        applicationTool("create_party_bank_account")!.visibleTo(crmWithoutPermissions.authz),
        false,
      );
      await assert.rejects(
        withOrgContext(first.orgId, () =>
          executeApplicationTool(crmStageTool, crmWithoutPermissions, {
            opportunityId: randomUUID(),
            statusId: randomUUID(),
            expectedUpdatedAt: "000001",
            idempotencyKey: "crm-stage-no-permission-0001",
          }),
        ),
        /forbidden/,
      );

      const crmFull = ctxFor(first.orgId, firstActors.adminId, ["crm.opportunities.manage"]);
      const foreignOpportunityId = randomUUID();
      const foreignCreate = (await withOrgContext(first.orgId, () =>
        executeApplicationTool(applicationTool("create_crm_opportunity")!, crmFull, {
          partyId: first.customerId,
          idempotencyKey: "crm-cross-org-create-0001",
        }),
      )) as { opportunityId: string };
      await assert.rejects(
        withOrgContext(second.orgId, () =>
          executeApplicationTool(
            crmStageTool,
            ctxFor(second.orgId, secondActors.adminId, ["crm.opportunities.manage"]),
            {
              opportunityId: foreignCreate.opportunityId,
              statusId: foreignOpportunityId,
              expectedUpdatedAt: "000001",
              idempotencyKey: "crm-cross-org-stage-0001",
            },
          ),
        ),
        /not_found|not found/,
      );
      await setCrmEnabled(first.orgId, false);
      try {
        await assert.rejects(
          withOrgContext(first.orgId, () =>
            executeApplicationTool(crmStageTool, crmFull, {
              opportunityId: foreignCreate.opportunityId,
              statusId: foreignOpportunityId,
              expectedUpdatedAt: "000001",
              idempotencyKey: "crm-stage-feature-off-0001",
            }),
          ),
          /crm record not found/,
        );
      } finally {
        await setCrmEnabled(first.orgId, true);
      }
      await setServiceEnabled(first.orgId, false);
      try {
        await assert.rejects(
          withOrgContext(first.orgId, () =>
            executeApplicationTool(applicationTool("create_service_request")!, full, {
              ...input,
              id: randomUUID(),
              idempotencyKey: "service-request-feature-off-0001",
            }),
          ),
          /needs the serviceDispatch feature/,
        );
      } finally {
        await setServiceEnabled(first.orgId, true);
      }

      const other = ctxFor(second.orgId, secondActors.adminId, ["service.manage", "service.read"]);
      await assert.rejects(
        withOrgContext(second.orgId, () =>
          executeApplicationTool(applicationTool("get_service_request")!, other, {
            requestId: created.id,
          }),
        ),
        /not found/,
      );
    } finally {
      await dropScratchOrg(first.orgId);
      await dropScratchOrg(second.orgId);
    }
  },
);
