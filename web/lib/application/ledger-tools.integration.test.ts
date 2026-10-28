import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors, grantScratchPermissions } =
  await import("@openbooks/engine/testing/fixtures");
const { getRun, getRuleVersion } = await import("@openbooks/engine/allocations/runtime");
const { postProjectGlEntry } = await import("@openbooks/engine/projects/recognition");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
const { getApplicationBudget } = await import("./budgets.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;
const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Ledger test",
        orgId,
        roles: [{ key: "ledger-role", name: "Ledger role" }],
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

async function pinnedGroup(orgId: string, accountId: string): Promise<string | null> {
  return withBypassContext(async () => {
    const rows = await db.execute<{ group_id: string }>(
      sql`
      select group_id from account_group_members
       where org_id = ${orgId} and account_id = ${accountId}
    `,
      "objects",
    );
    return rows[0]?.group_id ?? null;
  });
}

test(
  "ledger commands pin account groups with replay, permission, feature and tenant guards",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const foreign = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const foreignActors = await withBypassContext(() => seedFlowActors(foreign.orgId));
      const groupId = randomUUID();
      const accountId = org.accounts.cogs;
      await withBypassContext(() =>
        db.execute(sql`
          insert into account_groups
            (id, org_id, dimension, key, name, sort_order, match, is_catch_all, is_active, created_by)
          values
            (${groupId}, ${org.orgId}, 'ledger-tool-test', 'ledger-tool-test', 'Ledger tool test',
             1, '{}'::jsonb, false, true, ${actors.adminId})
        `),
      );
      const context = ctxFor(org.orgId, actors.adminId, ["admin.setup.manage"]);
      const run = (name: string, ctx: ApplicationContext, input: Record<string, unknown>) =>
        withOrgContext(ctx.authz.user.orgId, () =>
          executeApplicationTool(applicationTool(name)!, ctx, input),
        );

      const closeContext = ctxFor(org.orgId, actors.adminId, ["periods.manage"]);
      const blueprintDraft = {
        name: "Ledger close blueprint",
        steps: [
          {
            key: "review-ledger",
            title: "Review ledger",
            workstream: "gl",
            taskType: "check",
            completionMode: "manual",
            gateType: "hard",
            description: "Review the general ledger close balances.",
            dueOffsetBusinessDays: 1,
            evidenceRequired: true,
            defaultOwnerRoleKey: null,
            applicability: {},
            dependsOn: [],
          },
        ],
        idempotencyKey: "ledger-close-blueprint-feature-001",
      };
      await withBypassContext(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,advancedClose}', 'false'::jsonb, true)
           where id = ${org.orgId}
        `),
      );
      await assert.rejects(
        run("save_close_blueprint", closeContext, blueprintDraft),
        /needs advancedClose feature/i,
      );
      await withBypassContext(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,advancedClose}', 'true'::jsonb, true)
           where id = ${org.orgId}
        `),
      );

      const initialCalendar = await withBypassContext(async () => {
        const rows = await db.execute<{
          id: string;
          name: string;
          cadence: string;
          year_start_month: number;
          week_starts_on: number;
          anchor_date: string | null;
          time_zone: string;
          adjustment_period_enabled: boolean;
          is_default: boolean;
          is_active: boolean;
          config: Record<string, unknown>;
        }>(
          sql`select * from fiscal_calendars where org_id = ${org.orgId} and is_default and is_active limit 1`,
          "objects",
        );
        return rows[0];
      });
      assert.ok(initialCalendar);
      const calendarCadences = [
        "monthly",
        "four_four_five",
        "four_five_four",
        "five_four_four",
        "thirteen_period",
        "custom",
      ] as const;
      assert.ok(
        calendarCadences.includes(initialCalendar.cadence as (typeof calendarCadences)[number]),
      );
      const calendarInput = {
        id: initialCalendar.id,
        name: "Ledger tool fiscal calendar",
        cadence: initialCalendar.cadence as (typeof calendarCadences)[number],
        yearStartMonth: initialCalendar.year_start_month,
        weekStartsOn: initialCalendar.week_starts_on,
        anchorDate: initialCalendar.anchor_date,
        timeZone: initialCalendar.time_zone,
        adjustmentPeriodEnabled: initialCalendar.adjustment_period_enabled,
        isDefault: true,
        isActive: true,
        config: initialCalendar.config,
        idempotencyKey: "ledger-save-calendar-001",
      };
      const savedCalendar = (await run("save_fiscal_calendar", closeContext, calendarInput)) as {
        id: string;
        replayed: boolean;
      };
      assert.equal(savedCalendar.replayed, false);
      assert.equal(savedCalendar.id, initialCalendar.id);
      const calendarRead = await withBypassContext(() =>
        db.execute<{ name: string }>(
          sql`select name from fiscal_calendars where id = ${savedCalendar.id} and org_id = ${org.orgId}`,
          "objects",
        ),
      );
      assert.equal(calendarRead[0]?.name, "Ledger tool fiscal calendar");
      const auditCount = await withBypassContext(() =>
        db.execute<{ count: string }>(
          sql`select count(*)::text as count from audit_log
               where org_id = ${org.orgId} and table_name = 'fiscal_calendars' and row_id = ${savedCalendar.id}`,
          "objects",
        ),
      );
      const calendarReplay = (await run("save_fiscal_calendar", closeContext, calendarInput)) as {
        replayed: boolean;
        id: string;
      };
      assert.equal(calendarReplay.replayed, true);
      assert.equal(calendarReplay.id, savedCalendar.id);
      const replayAuditCount = await withBypassContext(() =>
        db.execute<{ count: string }>(
          sql`select count(*)::text as count from audit_log
               where org_id = ${org.orgId} and table_name = 'fiscal_calendars' and row_id = ${savedCalendar.id}`,
          "objects",
        ),
      );
      assert.equal(replayAuditCount[0]?.count, auditCount[0]?.count);
      const closeConfiguration = (await run(
        "list_close_setup_configuration",
        closeContext,
        {},
      )) as {
        calendars: Array<{ id: string; name: string }>;
      };
      assert.equal(
        closeConfiguration.calendars.find((calendar) => calendar.id === savedCalendar.id)?.name,
        "Ledger tool fiscal calendar",
      );
      await assert.rejects(
        run("save_fiscal_calendar", ctxFor(org.orgId, actors.adminId, []), calendarInput),
        /forbidden/i,
      );
      const foreignCloseConfiguration = (await run(
        "list_close_setup_configuration",
        ctxFor(foreign.orgId, foreignActors.adminId, ["periods.manage"]),
        {},
      )) as { calendars: Array<{ id: string }> };
      assert.equal(
        foreignCloseConfiguration.calendars.some((calendar) => calendar.id === savedCalendar.id),
        false,
      );

      const first = (await run("pin_account_group", context, {
        groupId,
        accountId,
        idempotencyKey: "ledger-pin-account-001",
      })) as { replayed: boolean };
      assert.equal(first.replayed, false);
      assert.equal(await pinnedGroup(org.orgId, accountId), groupId);

      const replay = (await run("pin_account_group", context, {
        groupId,
        accountId,
        idempotencyKey: "ledger-pin-account-001",
      })) as { replayed: boolean };
      assert.equal(replay.replayed, true);
      assert.equal(await pinnedGroup(org.orgId, accountId), groupId);

      await run("unpin_account_group", context, {
        groupId,
        accountId,
        idempotencyKey: "ledger-unpin-account-001",
      });
      assert.equal(await pinnedGroup(org.orgId, accountId), null);

      await withBypassContext(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,allocations}', 'true'::jsonb, true)
           where id = ${org.orgId}
        `),
      );
      await withBypassContext(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,budgets}', 'true'::jsonb, true)
           where id = ${org.orgId}
        `),
      );
      const budgetContext = ctxFor(org.orgId, actors.adminId, ["budgets.manage"]);
      const budget = (await run("create_budget_scenario", budgetContext, {
        name: "Ledger command budget",
        kind: "budget",
        idempotencyKey: "ledger-create-budget-001",
      })) as { replayed: boolean; scenarioId: string };
      assert.equal(budget.replayed, false);
      const nativeBudget = await withOrgContext(org.orgId, () =>
        getApplicationBudget(
          ctxFor(org.orgId, actors.adminId, ["budgets.read"]),
          budget.scenarioId,
        ),
      );
      assert.equal(nativeBudget.status, "draft");
      assert.equal(Number(nativeBudget.revision), 1);
      const updatedBudget = (await run("update_budget_scenario", budgetContext, {
        scenarioId: budget.scenarioId,
        expectedRevision: Number(nativeBudget.revision),
        name: "Ledger command budget revised",
        idempotencyKey: "ledger-update-budget-001",
      })) as { replayed: boolean; revision: number };
      assert.equal(updatedBudget.replayed, false);
      const updatedNativeBudget = await withOrgContext(org.orgId, () =>
        getApplicationBudget(
          ctxFor(org.orgId, actors.adminId, ["budgets.read"]),
          budget.scenarioId,
        ),
      );
      assert.equal(updatedNativeBudget.name, "Ledger command budget revised");
      assert.equal(Number(updatedNativeBudget.revision), 2);
      const updateReplay = (await run("update_budget_scenario", budgetContext, {
        scenarioId: budget.scenarioId,
        expectedRevision: Number(nativeBudget.revision),
        name: "Ledger command budget revised",
        idempotencyKey: "ledger-update-budget-001",
      })) as { replayed: boolean; revision: number };
      assert.equal(updateReplay.replayed, true);
      assert.equal(updateReplay.revision, updatedBudget.revision);
      const budgetReplay = (await run("create_budget_scenario", budgetContext, {
        name: "Ledger command budget",
        kind: "budget",
        idempotencyKey: "ledger-create-budget-001",
      })) as { replayed: boolean; scenarioId: string };
      assert.equal(budgetReplay.replayed, true);
      assert.equal(budgetReplay.scenarioId, budget.scenarioId);
      const budgetCount = await withBypassContext(() =>
        db.execute<{ count: string }>(
          sql`
          select count(*)::text as count from budget_scenarios
          where org_id = ${org.orgId} and name = 'Ledger command budget revised'
        `,
          "objects",
        ),
      );
      assert.equal(budgetCount[0]?.count, "1");

      const disposableBudget = (await run("create_budget_scenario", budgetContext, {
        name: "Ledger command budget deletion",
        idempotencyKey: "ledger-create-budget-delete-001",
      })) as { scenarioId: string };
      await run("delete_budget_scenario", budgetContext, {
        scenarioId: disposableBudget.scenarioId,
        idempotencyKey: "ledger-delete-budget-001",
      });
      const deletedBudget = await withBypassContext(() =>
        db.execute<{ count: string }>(
          sql`select count(*)::text as count from budget_scenarios where id = ${disposableBudget.scenarioId} and org_id = ${org.orgId}`,
          "objects",
        ),
      );
      assert.equal(deletedBudget[0]?.count, "0");

      const allocationContext = ctxFor(org.orgId, actors.adminId, ["allocations.manage"]);
      const createdRule = (await run("create_allocation_rule", allocationContext, {
        key: "ledger-tool-run",
        name: "Ledger tool run",
        mode: "period",
        idempotencyKey: "ledger-create-allocation-rule-001",
      })) as {
        replayed: boolean;
        rule: { id: string };
        version: { id: string; revision: string };
      };
      assert.equal(createdRule.replayed, false);
      const ruleId = createdRule.rule.id;
      const draftVersion = createdRule.version;
      const nativeDraft = await withOrgContext(org.orgId, () =>
        getRuleVersion(org.orgId, draftVersion.id, null),
      );
      assert.equal(nativeDraft.version.status, "draft");
      const createReplay = (await run("create_allocation_rule", allocationContext, {
        key: "ledger-tool-run",
        name: "Ledger tool run",
        mode: "period",
        idempotencyKey: "ledger-create-allocation-rule-001",
      })) as { replayed: boolean; rule: { id: string } };
      assert.equal(createReplay.replayed, true);
      assert.equal(createReplay.rule.id, ruleId);

      const departmentId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into departments (id, org_id, name, is_active, custom)
          values (${departmentId}, ${org.orgId}, 'Ledger tool department', true, '{}'::jsonb)
        `);
      });
      const updatedDraft = (await run("update_allocation_rule_version", allocationContext, {
        ruleId,
        versionId: draftVersion.id,
        expectedRevision: draftVersion.revision,
        // Period-based versions start on a period boundary.
        effectiveFrom: `${org.date.slice(0, 7)}-01`,
        accountScope: { kind: "accounts", accountIds: [org.accounts.adjustment] },
        basisKind: "fixed_percent",
        idempotencyKey: "ledger-update-allocation-version-001",
      })) as { version: { revision: string } };
      const targets = (await run("replace_allocation_rule_targets", allocationContext, {
        ruleId,
        versionId: draftVersion.id,
        expectedRevision: updatedDraft.version.revision,
        targets: [
          {
            sequence: 1,
            departmentId,
            fixedPercent: "100.0000",
            isRemainder: false,
            label: "Ledger tool department",
          },
        ],
        idempotencyKey: "ledger-replace-allocation-targets-001",
      })) as { revision: string };
      const published = (await run("publish_allocation_rule_version", allocationContext, {
        ruleId,
        versionId: draftVersion.id,
        idempotencyKey: "ledger-publish-allocation-version-001",
      })) as { version: { id: string } };
      const nativePublished = await withOrgContext(org.orgId, () =>
        getRuleVersion(org.orgId, published.version.id, null),
      );
      assert.equal(nativePublished.version.status, "published");
      assert.ok(targets.revision);
      await withOrgContext(org.orgId, () =>
        postProjectGlEntry({
          orgId: org.orgId,
          actorId: actors.adminId,
          origin: "manual",
          entryNumber: `LEDGER-TOOLS-${randomUUID()}`,
          postingDate: org.date,
          memo: "Ledger tool allocation source",
          subsidiaryId: org.subsidiaryId,
          currency: "CAD",
          lines: [
            { accountId: org.accounts.adjustment, amount: "100.0000" },
            { accountId: org.accounts.bank, amount: "-100.0000" },
          ],
        }),
      );
      const runContext = ctxFor(org.orgId, actors.adminId, ["allocations.run", "gl.post"]);
      const previewResult = (await run("run_allocation_rule", runContext, {
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        idempotencyKey: "ledger-run-allocation-001",
      })) as { replayed: boolean; runId: string };
      assert.equal(previewResult.replayed, false);
      const preview = await withOrgContext(org.orgId, () => getRun(org.orgId, previewResult.runId));
      assert.equal(preview.status, "previewed");
      const previewReplay = (await run("run_allocation_rule", runContext, {
        ruleId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        idempotencyKey: "ledger-run-allocation-001",
      })) as { replayed: boolean; runId: string };
      assert.equal(previewReplay.replayed, true);
      assert.equal(previewReplay.runId, preview.id);
      const runCount = await withBypassContext(() =>
        db.execute<{ count: string }>(
          sql`
          select count(*)::text as count from allocation_runs
           where org_id = ${org.orgId} and rule_id = ${ruleId}
        `,
          "objects",
        ),
      );
      assert.equal(runCount[0]?.count, "1");

      const postingContext = ctxFor(org.orgId, actors.adminId, ["allocations.run", "gl.post"]);
      const posted = (await run("post_allocation_run", postingContext, {
        runId: preview.id,
        reason: "Ledger tool integration posting",
        idempotencyKey: "ledger-post-allocation-001",
      })) as { replayed: boolean };
      assert.equal(posted.replayed, false);
      const postedRun = await withOrgContext(org.orgId, () => getRun(org.orgId, preview.id));
      assert.equal(postedRun.status, "posted");
      assert.ok(postedRun.journalEntryId);
      const postReplay = (await run("post_allocation_run", postingContext, {
        runId: preview.id,
        reason: "Ledger tool integration posting",
        idempotencyKey: "ledger-post-allocation-001",
      })) as { replayed: boolean };
      assert.equal(postReplay.replayed, true);
      const afterReplay = await withOrgContext(org.orgId, () => getRun(org.orgId, preview.id));
      assert.equal(afterReplay.journalEntryId, postedRun.journalEntryId);

      await assert.rejects(
        run("pin_account_group", ctxFor(org.orgId, actors.adminId, []), {
          groupId,
          accountId,
          idempotencyKey: "ledger-pin-denied-001",
        }),
        /forbidden/i,
      );

      await assert.rejects(
        run(
          "pin_account_group",
          ctxFor(foreign.orgId, foreignActors.adminId, ["admin.setup.manage"]),
          { groupId, accountId: foreign.accounts.cogs, idempotencyKey: "ledger-pin-tenant-001" },
        ),
        /not found|forbidden/i,
      );

      await withBypassContext(() =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,continuousClose}', 'false'::jsonb, true)
           where id = ${org.orgId}
        `),
      );
      await assert.rejects(
        run("run_continuous_close_agent", ctxFor(org.orgId, actors.adminId, ["admin.ai.manage"]), {
          agentKey: "accounting",
          idempotencyKey: "ledger-cc-feature-off-001",
        }),
        /disabled|feature/i,
      );
      assert.equal(await pinnedGroup(foreign.orgId, foreign.accounts.cogs), null);
    } finally {
      await dropScratchOrg(foreign.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "provision assessment commands preserve proposal replay, permission, readback and tenant scope",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const foreign = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const foreignActors = await withBypassContext(() => seedFlowActors(foreign.orgId));
      const expense = randomUUID();
      const liability = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
          update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{reportingFramework}', '"ifrs"'::jsonb, true)
          where id = ${org.orgId}
        `);
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type) values
            (${expense}, ${org.orgId}, 'LEDGER-PROV-EXP', 'Provision expense', 'expense'),
            (${liability}, ${org.orgId}, 'LEDGER-PROV-LIAB', 'Provision liability', 'liability_current_other')
        `);
        await grantScratchPermissions(org.orgId, actors.submitterId, ["gl.manage", "gl.read"]);
        await grantScratchPermissions(foreign.orgId, foreignActors.adminId, ["gl.read"]);
      });

      const proposal = {
        obligation: {
          id: randomUUID(),
          subsidiaryId: org.subsidiaryId,
          bookId: org.bookId,
          name: "Legal settlement obligation",
          currency: "CAD",
          expenseAccountId: expense,
          liabilityAccountId: liability,
        },
        effectiveOn: org.date,
        reason: "Accrue the supported probable settlement obligation",
        idempotencyKey: "ledger-provision-assessment-001",
        assessment: {
          presentObligation: true,
          outflow: "probable",
          reliablyEstimable: true,
          evidence:
            "Counsel confirms a present legal obligation from defective work and a probable settlement.",
          discounting: "immaterial",
          discountEvidence:
            "Settlement is expected shortly; counsel confirms time value is immaterial.",
          estimate: { method: "best_estimate", amount: "50000" },
        },
      };
      const manageContext = ctxFor(org.orgId, actors.submitterId, ["gl.manage"]);
      const readContext = ctxFor(org.orgId, actors.submitterId, ["gl.read"]);
      const run = (name: string, context: ApplicationContext, input: Record<string, unknown>) =>
        withOrgContext(context.authz.user.orgId, () =>
          executeApplicationTool(applicationTool(name)!, context, input),
        );

      const created = (await run("propose_provision_assessment", manageContext, proposal)) as {
        id: string;
        replayed: boolean;
      };
      assert.equal(created.replayed, false);
      const replay = (await run("propose_provision_assessment", manageContext, proposal)) as {
        id: string;
        replayed: boolean;
      };
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, created.id);

      const changes = (await run("list_accounting_changes", readContext, {
        page: 1,
        perPage: 100,
      })) as { rows: Array<Record<string, unknown>> };
      assert.ok(changes.rows.some((row) => row.id === created.id && row.domain === "provision"));
      const proposalCount = await withBypassContext(() =>
        db.execute<{ count: string }>(
          sql`select count(*)::text as count from financial_changes
               where org_id = ${org.orgId} and id = ${created.id}`,
          "objects",
        ),
      );
      assert.equal(proposalCount[0]?.count, "1");

      await assert.rejects(
        run("propose_provision_assessment", ctxFor(org.orgId, actors.submitterId, []), {
          ...proposal,
          idempotencyKey: "ledger-provision-assessment-denied",
        }),
        /forbidden/i,
      );
      const foreignChanges = (await run(
        "list_accounting_changes",
        ctxFor(foreign.orgId, foreignActors.adminId, ["gl.read"]),
        { page: 1, perPage: 100 },
      )) as { rows: Array<Record<string, unknown>> };
      assert.equal(
        foreignChanges.rows.some((row) => row.id === created.id),
        false,
      );

      await withBypassContext(() =>
        db.execute(sql`
          update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,multiBookAccounting}', 'false'::jsonb, true)
          where id = ${org.orgId}
        `),
      );
      await assert.rejects(
        run("get_accounting_book_replication_status", readContext, {}),
        /needs multiBookAccounting feature/i,
      );
    } finally {
      await dropScratchOrg(foreign.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
