import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { writeSalesCommand, previewTerritory } from "./sales.ts";
import { ensureCrmDefaults } from "./crm.ts";
import {
  EMPTY_TERRITORY_GEOGRAPHY,
  type SalesCommand,
  type SalesRecord,
} from "./sales-contracts.ts";

function databaseRefusal(pattern: RegExp) {
  return (error: unknown) => {
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause
        : error;
    assert.ok(cause instanceof Error);
    assert.match(cause.message, pattern);
    return true;
  };
}
const DB = !!process.env.OPENBOOKS_DB_URL;
test(
  "native sales employee identities, controlled quotas and immutable attribution",
  { skip: !DB },
  async (t) => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const maker = await withBypassContext(() =>
        createScratchUser(org.orgId, "Sales preparer", "sales_preparer"),
      );
      const checker = await withBypassContext(() =>
        createScratchUser(org.orgId, "Sales approver", "sales_approver"),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set permissions='["crm.setup.manage","crm.forecasts.override"]'::jsonb where org_id=${org.orgId}`,
        ),
      );
      await withBypassContext(() => ensureCrmDefaults(org.orgId, maker));
      const employee = await withOrg(org.orgId, async () => {
        const p = (
          await db.execute<{ id: string }>(
            sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${org.orgId},'employee','Native employee without login',${org.subsidiaryId}) returning id`,
          )
        ).rows[0]!;
        await db.execute(
          sql`insert into employee_roles(org_id,party_id,is_sales_rep,sales_rep_since) values(${org.orgId},${p.id},true,'2020-01-01')`,
        );
        return p.id;
      });
      const scope = {
        orgId: org.orgId,
        actorId: maker,
        allowedSubsidiaryIds: null,
      };
      const write = (command: SalesCommand, actorId = maker) =>
        withOrg(org.orgId, () =>
          writeSalesCommand({ ...scope, actorId }, command),
        ) as Promise<SalesRecord>;
      let salesTeam: SalesRecord;
      let quota: SalesRecord;
      await t.test(
        "employees can own teams and quotas without a login",
        async () => {
          salesTeam = await write({
            action: "team",
            name: "Enterprise sales",
            subsidiaryId: org.subsidiaryId,
            managerEmployeeId: employee,
            isActive: true,
            members: [
              {
                employeeId: employee,
                role: "manager",
                validFrom: "2020-01-01",
              },
            ],
          });
          quota = await write({
            action: "quota",
            name: "September target",
            subsidiaryId: org.subsidiaryId,
            employeeId: employee,
            salesTeamId: null,
            parentQuotaId: null,
            supersedesId: null,
            reason: "",
            periodStart: "2026-09-01",
            periodEnd: "2026-09-30",
            currency: "CAD",
            amount: "1234.5678",
            metric: "closed_won",
          });
          assert.equal(quota.employee_id, employee);
          assert.equal(quota.amount, "1234.5678");
          assert.equal(salesTeam.manager_employee_id, employee);
        },
      );
      await t.test(
        "cross-entity and stale record writes are refused",
        async () => {
          await assert.rejects(
            () =>
              withOrg(org.orgId, () =>
                writeSalesCommand(
                  { ...scope, allowedSubsidiaryIds: new Set() },
                  {
                    action: "quota",
                    name: "Forbidden",
                    subsidiaryId: org.subsidiaryId,
                    employeeId: employee,
                    salesTeamId: null,
                    parentQuotaId: null,
                    supersedesId: null,
                    reason: "",
                    periodStart: "2026-09-01",
                    periodEnd: "2026-09-30",
                    currency: "CAD",
                    amount: "1",
                    metric: "closed_won",
                  },
                ),
              ),
            /outside your permitted scope/,
          );
          await assert.rejects(
            () =>
              write({
                action: "quota-transition",
                id: quota.id,
                expectedRevision: 99,
                lifecycle: "pending_approval",
                reason: "Submit",
              }),
            /changed/,
          );
        },
      );
      await t.test(
        "quota maker cannot approve, but a different live authorized actor can",
        async () => {
          quota = await write({
            action: "quota-transition",
            id: quota.id,
            expectedRevision: quota.revision,
            lifecycle: "pending_approval",
            reason: "Ready for review",
          });
          await assert.rejects(
            () =>
              write({
                action: "quota-transition",
                id: quota.id,
                expectedRevision: quota.revision,
                lifecycle: "approved",
                reason: "Self approval",
              }),
            /different authorized manager/,
          );
          quota = await write(
            {
              action: "quota-transition",
              id: quota.id,
              expectedRevision: quota.revision,
              lifecycle: "approved",
              reason: "Independent review",
            },
            checker,
          );
          assert.equal(quota.approved_by, checker);
          await assert.rejects(
            () =>
              withOrg(org.orgId, () =>
                db.execute(
                  sql`update crm_sales_quotas set amount='999' where id=${quota.id} and org_id=${org.orgId}`,
                ),
              ),
            databaseRefusal(/Approved quotas are immutable/),
          );
        },
      );
      await t.test(
        "quota approval refuses overlapping targets and preserves revision history",
        async () => {
          let duplicate = await write({
            action: "quota",
            name: "Overlap",
            subsidiaryId: org.subsidiaryId,
            employeeId: employee,
            salesTeamId: null,
            parentQuotaId: null,
            supersedesId: null,
            reason: "",
            periodStart: "2026-09-01",
            periodEnd: "2026-09-30",
            currency: "CAD",
            amount: "20",
            metric: "closed_won",
          });
          duplicate = await write({
            action: "quota-transition",
            id: duplicate.id,
            expectedRevision: duplicate.revision,
            lifecycle: "pending_approval",
            reason: "Review overlap",
          });
          await assert.rejects(
            () =>
              write(
                {
                  action: "quota-transition",
                  id: duplicate.id,
                  expectedRevision: duplicate.revision,
                  lifecycle: "approved",
                  reason: "Review",
                },
                checker,
              ),
            /approved quota already covers/,
          );
          let revision = await write({
            action: "quota",
            name: "Revised September",
            subsidiaryId: org.subsidiaryId,
            employeeId: employee,
            salesTeamId: null,
            parentQuotaId: null,
            supersedesId: quota.id,
            reason: "Territory expansion",
            periodStart: "2026-09-01",
            periodEnd: "2026-09-30",
            currency: "CAD",
            amount: "1300.0000",
            metric: "closed_won",
          });
          revision = await write({
            action: "quota-transition",
            id: revision.id,
            expectedRevision: revision.revision,
            lifecycle: "pending_approval",
            reason: "Review revision",
          });
          revision = await write(
            {
              action: "quota-transition",
              id: revision.id,
              expectedRevision: revision.revision,
              lifecycle: "approved",
              reason: "Approved expansion",
            },
            checker,
          );
          const old = await withOrg(org.orgId, () =>
            db.execute<{ lifecycle: string; amount: string }>(
              sql`select lifecycle,amount::text from crm_sales_quotas where id=${quota.id} and org_id=${org.orgId}`,
            ),
          );
          assert.equal(old.rows[0]?.lifecycle, "superseded");
          assert.equal(old.rows[0]?.amount, "1234.5678");
        },
      );
      await t.test(
        "team allocations reconcile exactly and closed targets retain their approved decision",
        async () => {
          const template = {
            action: "quota" as const,
            name: "November team target",
            subsidiaryId: org.subsidiaryId,
            employeeId: null,
            salesTeamId: salesTeam.id,
            parentQuotaId: null,
            supersedesId: null,
            reason: "",
            periodStart: "2026-11-01",
            periodEnd: "2026-11-30",
            currency: "CAD",
            amount: "100.0001",
            metric: "closed_won" as const,
          };
          let parent = await write(template);
          let child = await write({
            ...template,
            name: "Representative allocation",
            employeeId: employee,
            salesTeamId: null,
            parentQuotaId: parent.id,
            amount: "100.0000",
          });
          child = await write({
            action: "quota-transition",
            id: child.id,
            expectedRevision: child.revision,
            lifecycle: "pending_approval",
            reason: "Prepared allocation",
          });
          child = await write(
            {
              action: "quota-transition",
              id: child.id,
              expectedRevision: child.revision,
              lifecycle: "approved",
              reason: "Allocation verified",
            },
            checker,
          );
          parent = await write({
            action: "quota-transition",
            id: parent.id,
            expectedRevision: parent.revision,
            lifecycle: "pending_approval",
            reason: "Prepared team plan",
          });
          await assert.rejects(
            () =>
              write(
                {
                  action: "quota-transition",
                  id: parent.id,
                  expectedRevision: parent.revision,
                  lifecycle: "approved",
                  reason: "Review totals",
                },
                checker,
              ),
            /reconcile/,
          );
          parent = await write({
            action: "quota-transition",
            id: parent.id,
            expectedRevision: parent.revision,
            lifecycle: "draft",
            reason: "Correct target total",
          });
          parent = await write({
            ...template,
            id: parent.id,
            expectedRevision: parent.revision,
            amount: "100.0000",
          });
          parent = await write({
            action: "quota-transition",
            id: parent.id,
            expectedRevision: parent.revision,
            lifecycle: "pending_approval",
            reason: "Reconciled plan",
          });
          parent = await write(
            {
              action: "quota-transition",
              id: parent.id,
              expectedRevision: parent.revision,
              lifecycle: "approved",
              reason: "Approved reconciled plan",
            },
            checker,
          );
          await assert.rejects(
            () =>
              write({
                action: "quota-transition",
                id: parent.id,
                expectedRevision: parent.revision,
                lifecycle: "closed",
                reason: "Plan concluded",
              }),
            /Close the representative allocations/,
          );
          child = await write({
            action: "quota-transition",
            id: child.id,
            expectedRevision: child.revision,
            lifecycle: "closed",
            reason: "Allocation concluded",
          });
          const closed = await write({
            action: "quota-transition",
            id: parent.id,
            expectedRevision: parent.revision,
            lifecycle: "closed",
            reason: "Plan concluded",
          });
          assert.equal(closed.amount, "100.0000");
          assert.equal(closed.reason, "Approved reconciled plan");
          assert.equal(closed.approved_by, checker);
        },
      );
      await t.test(
        "feature disabling preserves configuration and refuses native service writes",
        async () => {
          const before = await withOrg(org.orgId, () =>
            db.execute<{ count: number }>(
              sql`select count(*)::int as count from crm_sales_quotas where org_id=${org.orgId}`,
            ),
          );
          await withBypassContext(() =>
            db.execute(
              sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"salesManagement":false}'::jsonb) where id=${org.orgId}`,
            ),
          );
          try {
            await assert.rejects(
              () =>
                write({
                  action: "team",
                  name: "Disabled write",
                  subsidiaryId: org.subsidiaryId,
                  managerEmployeeId: null,
                  isActive: true,
                  members: [],
                }),
              /disabled.*Company Settings/,
            );
            const after = await withOrg(org.orgId, () =>
              db.execute<{ count: number }>(
                sql`select count(*)::int as count from crm_sales_quotas where org_id=${org.orgId}`,
              ),
            );
            assert.equal(after.rows[0]?.count, before.rows[0]?.count);
          } finally {
            await withBypassContext(() =>
              db.execute(
                sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"salesManagement":true}'::jsonb) where id=${org.orgId}`,
              ),
            );
          }
        },
      );
      await t.test(
        "published territories route native employees and refuse stale previews",
        async () => {
          await withOrg(org.orgId, () =>
            db.execute(
              sql`update parties set subsidiary_id=${org.subsidiaryId} where org_id=${org.orgId} and id=${org.customerId}`,
            ),
          );
          await withOrg(org.orgId, () =>
            db.execute(
              sql`insert into crm_account_profiles(org_id,party_id,lifecycle_stage) values(${org.orgId},${org.customerId},'customer')`,
            ),
          );
          const territory: Extract<SalesCommand, { action: "territory" }> = {
            action: "territory",
            name: "Customer coverage",
            subsidiaryId: org.subsidiaryId,
            managerEmployeeId: employee,
            defaultEmployeeId: employee,
            salesTeamId: salesTeam.id,
            description: "",
            priority: 100,
            rules: [
              {
                field: "lifecycleStage",
                operator: "equals",
                value: "customer",
              },
            ],
            matchMode: "all",
            geography: EMPTY_TERRITORY_GEOGRAPHY,
            effectiveFrom: "2020-01-01",
            lifecycle: "active",
          };
          const preview = await withOrg(org.orgId, () =>
            db.transaction((tx) => previewTerritory(tx, scope, territory)),
          );
          await assert.rejects(
            () => write({ ...territory, previewRevision: "0".repeat(64) }),
            /Preview.*again/,
          );
          const saved = await write({
            ...territory,
            previewRevision: preview.revision,
          });
          const account = await withOrg(org.orgId, () =>
            db.execute<{ sales_rep_id: string; territory_id: string }>(
              sql`select sales_rep_id,territory_id from crm_account_profiles where org_id=${org.orgId} and party_id=${org.customerId}`,
            ),
          );
          assert.equal(account.rows[0]?.sales_rep_id, employee);
          assert.equal(account.rows[0]?.territory_id, saved.id);
          const another = { ...territory, name: "Overlapping coverage" };
          const conflict = await withOrg(org.orgId, () =>
            db.transaction((tx) => previewTerritory(tx, scope, another)),
          );
          assert.ok(conflict.conflicts > 0);
          await assert.rejects(
            () => write({ ...another, previewRevision: conflict.revision }),
            /overlapping territory/,
          );
        },
      );
      await t.test(
        "sales evidence freezes employee and amount, with a controlled reopening reversal",
        async () => {
          const statuses = await withOrg(org.orgId, () =>
            db.execute<{ id: string; is_won: boolean }>(
              sql`select id,is_won from crm_opportunity_statuses where org_id=${org.orgId} and key in ('closed_won','qualification') order by is_won`,
            ),
          );
          const won = statuses.rows.find((s) => s.is_won)!.id;
          const open = statuses.rows.find((s) => !s.is_won)!.id;
          const opportunity = await withOrg(org.orgId, () =>
            db.execute<{ id: string }>(
              sql`insert into crm_opportunities(org_id,opportunity_number,title,status_id,sales_rep_id,sales_team_id,subsidiary_id,currency,projected_amount,closed_at,updated_by) values(${org.orgId},'OPP-SALES','Native attribution',${won},${employee},${salesTeam.id},${org.subsidiaryId},'CAD','10.1234','2026-09-10',${maker}) returning id`,
            ),
          );
          const id = opportunity.rows[0]!.id;
          await assert.rejects(
            () =>
              withOrg(org.orgId, () =>
                db.execute(
                  sql`update crm_opportunities set projected_amount='20' where org_id=${org.orgId} and id=${id}`,
                ),
              ),
            databaseRefusal(/Closed-won sales evidence is immutable/),
          );
          await withOrg(org.orgId, () =>
            db.execute(
              sql`update crm_opportunities set status_id=${open},win_loss_reason='Customer deferred purchase',closed_at=null,updated_at=clock_timestamp(),updated_by=${maker} where org_id=${org.orgId} and id=${id}`,
            ),
          );
          const evidence = await withOrg(org.orgId, () =>
            db.execute<{
              amount: string;
              employee_id: string;
              event_kind: string;
            }>(
              sql`select amount::text,employee_id,event_kind from crm_sales_evidence where org_id=${org.orgId} and source_id=${id} order by created_at,id`,
            ),
          );
          assert.equal(evidence.rows.length, 2);
          assert.deepEqual(
            evidence.rows.map((e) => e.amount),
            ["10.1234", "-10.1234"],
          );
          assert.ok(evidence.rows.every((e) => e.employee_id === employee));
          await assert.rejects(
            () =>
              withOrg(org.orgId, () =>
                db.execute(
                  sql`delete from crm_sales_evidence where org_id=${org.orgId} and source_id=${id}`,
                ),
              ),
            databaseRefusal(/Sales evidence is immutable/),
          );
          await assert.rejects(
            () =>
              withOrg(org.orgId, () =>
                db.execute(
                  sql`update employee_roles set is_sales_rep=false where org_id=${org.orgId} and party_id=${employee}`,
                ),
              ),
            databaseRefusal(/Reassign/),
          );
        },
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
