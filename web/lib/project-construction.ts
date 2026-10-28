import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "@openbooks/engine/platform/db";
import { lockAndCheckOrgFeature } from "@openbooks/engine/organization/org-feature-lock";
import { lockProjectForScope, withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { cmp, normalizeMoney, sum, wholeDigits } from "@openbooks/engine/money";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { acquireFeatureGateLock } from "./features";
import { projectBillingHasBegun } from "@openbooks/engine/projects/header-controls";
import {
  assertProjectIncomeAccountUsable,
  ConstructionBillingError,
  projectDefaultIncomeAccount,
  projectRetainageHeldSql,
} from "@openbooks/engine/projects/construction-billing";
import { projectCostSummary } from "./project-costing";
import { supportsApplicationsForPayment } from "./project-billing-procedure";
import { canonicalDecimal } from "./exact-decimal";
import { moneyRefusal } from "./payroll-decimal-refusal";

export interface ConstructionActor {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

async function pinIncomeAccount(
  exec: SqlExecutor,
  actor: ConstructionActor,
  projectSubsidiaryId: string | null,
  accountId: unknown,
): Promise<string | null> {
  if (accountId == null || accountId === "") return null;
  const id = String(accountId);
  if (!isUuid(id)) throw new ConstructionBillingError("Income account not found");
  return (
    await assertProjectIncomeAccountUsable(
      exec,
      actor.orgId,
      id,
      projectSubsidiaryId,
      actor.allowedSubsidiaryIds,
    )
  ).id;
}

async function lockProject(actor: ConstructionActor, projectId: string, tx: SqlExecutor) {
  return lockProjectForScope(tx, actor.orgId, projectId, actor.allowedSubsidiaryIds);
}

/** The construction page's repeatable-read view, shared by the API and command catalog. */
export async function loadProjectConstructionBilling(
  actor: Pick<ConstructionActor, "orgId" | "allowedSubsidiaryIds">,
  projectId: string,
) {
  if (!(await supportsApplicationsForPayment(actor.orgId, projectId))) {
    throw new ConstructionBillingError(
      "This project's billing profile does not use applications for payment",
    );
  }
  const committed = await projectCostSummary(actor.orgId, projectId, actor.allowedSubsidiaryIds);
  return withScopeSnapshot(actor.orgId, async () => {
    await lockProjectForScope(db, actor.orgId, projectId, actor.allowedSubsidiaryIds, "share");
    const retAcct = await db.execute<{ acct: string | null }>(
      sql`
      select a.id as acct
        from orgs o
        join accounts a on a.id = nullif(o.settings->'controlAccounts'->>'retainageReceivable', '')::uuid
                       and a.org_id = o.id
       where o.id = ${actor.orgId}
    `,
      "objects",
    );
    const retainageAccountId = retAcct[0]?.acct ?? null;
    const defaultIncomeAccount = await projectDefaultIncomeAccount(db, actor.orgId);
    const sov = await db.execute(
      sql`
      select l.id, l.item_no as "itemNo", l.description, l.scheduled_value as "scheduledValue",
             l.retainage_percent as "retainagePercent", l.income_account_id as "incomeAccountId",
             l.sort_order as "sortOrder", l.change_order_id as "changeOrderId",
             exists(select 1 from pay_application_lines pal
               join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
              where pal.org_id = ${actor.orgId} and pal.sov_line_id = l.id and pa.status <> 'void') as "usedByApplication"
        from sov_lines l where l.org_id = ${actor.orgId} and l.project_id = ${projectId} order by l.sort_order
    `,
      "objects",
    );
    const changeOrders = await db.execute(
      sql`
      select co.id, co.number, co.description, co.status, co.amount, co.approved_on as "approvedOn",
             co.target_sov_line_id as "targetSovLineId", sl.description as "targetSovLineDescription",
             co.income_account_id as "incomeAccountId"
        from change_orders co
        left join sov_lines sl on sl.id = co.target_sov_line_id and sl.org_id = co.org_id
       where co.org_id = ${actor.orgId} and co.project_id = ${projectId} order by co.number
    `,
      "objects",
    );
    const payApplications = await db.execute(
      sql`
      select pa.id, pa.application_number as "applicationNumber", pa.period_end as "periodEnd", pa.kind,
             pa.status, pa.retainage_percent as "retainagePercent", pa.invoice_document_id as "invoiceDocumentId",
             d.document_number as "invoiceNumber", d.total as "invoiceTotal", d.status as "invoiceStatus"
        from pay_applications pa
        left join documents d on d.id = pa.invoice_document_id and d.org_id = pa.org_id
       where pa.org_id = ${actor.orgId} and pa.project_id = ${projectId} order by pa.application_number
    `,
      "objects",
    );
    const held = retainageAccountId
      ? await db.execute<{ held: string }>(
          projectRetainageHeldSql(actor.orgId, projectId, retainageAccountId),
          "objects",
        )
      : [{ held: "0" }];
    return {
      sovLines: sov,
      changeOrders,
      defaultIncomeAccountId: defaultIncomeAccount,
      payApplications,
      contractSum: sum(sov.map((line) => String(line.scheduledValue ?? "0"))),
      retainageHeld: String(held[0]?.held ?? "0"),
      committedCost: committed.committed.cost,
      retainageConfigured: Boolean(retainageAccountId),
    };
  });
}

export async function createConstructionSovLine(
  actor: ConstructionActor,
  input: {
    projectId: string;
    description: string;
    scheduledValue: string;
    retainagePercent?: string | null;
    itemNo?: string | null;
    sortOrder?: number;
    incomeAccountId?: string | null;
  },
): Promise<string> {
  const description = input.description.trim();
  const scheduledRaw = canonicalDecimal(input.scheduledValue, 4);
  if (scheduledRaw === null)
    throw new ConstructionBillingError(moneyRefusal("Scheduled value", input.scheduledValue));
  const scheduledValue = normalizeMoney(scheduledRaw);
  if (wholeDigits(scheduledValue) > 15)
    throw new ConstructionBillingError(
      "Scheduled value is out of range — at most 15 whole digits fit the ledger",
    );
  const retainageRaw =
    input.retainagePercent == null || input.retainagePercent === ""
      ? null
      : canonicalDecimal(input.retainagePercent, 4);
  if (input.retainagePercent != null && input.retainagePercent !== "" && retainageRaw === null) {
    throw new ConstructionBillingError(
      moneyRefusal("Retainage percent", input.retainagePercent, "a percent"),
    );
  }
  const retainagePercent = retainageRaw === null ? null : normalizeMoney(retainageRaw);
  if (!description || cmp(scheduledValue, "0") <= 0)
    throw new ConstructionBillingError("Description and a positive scheduled value are required");
  if (
    retainagePercent !== null &&
    (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0)
  ) {
    throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
  }
  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder) || sortOrder > 2147483647 || sortOrder < -2147483648) {
    throw new ConstructionBillingError("Sort order must be a whole number the schedule can store");
  }
  return withOrgTransaction(actor.orgId, () =>
    db.transaction(async (tx) => {
      await acquireFeatureGateLock(actor.orgId, tx);
      if (!(await lockAndCheckOrgFeature(tx, actor.orgId, "projects")))
        throw new ConstructionBillingError("Projects feature is disabled");
      const project = await lockProject(actor, input.projectId, tx);
      const incomeAccountId = await pinIncomeAccount(
        tx,
        actor,
        project.subsidiaryId,
        input.incomeAccountId,
      );
      if (await projectBillingHasBegun(tx, actor.orgId, input.projectId)) {
        throw new ConstructionBillingError(
          "After billing begins, contract value must change through an approved change order",
        );
      }
      const created = await tx.execute<{ id: string }>(
        sql`
      insert into sov_lines (org_id, project_id, item_no, description, scheduled_value, retainage_percent,
                             income_account_id, sort_order, created_by, updated_by)
      values (${actor.orgId}, ${input.projectId}, ${input.itemNo ?? null}, ${description}, ${scheduledValue},
              ${retainagePercent}, ${incomeAccountId}, ${sortOrder}, ${actor.actorId}, ${actor.actorId})
      returning id
    `,
        "objects",
      );
      const id = created[0]?.id;
      if (!id) throw new ConstructionBillingError("The schedule line was not saved", 409);
      await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${actor.orgId}, 'sov_lines', ${id}, 'insert', ${JSON.stringify({ after: { projectId: input.projectId, itemNo: input.itemNo ?? null, description, scheduledValue, retainagePercent, incomeAccountId } })}::jsonb, ${actor.actorId})`);
      return id;
    }),
  );
}

export async function updateConstructionSovLine(
  actor: ConstructionActor,
  input: {
    projectId: string;
    id: string;
    description: string;
    scheduledValue: string;
    retainagePercent?: string | null;
    itemNo?: string | null;
    incomeAccountId?: string | null;
  },
): Promise<void> {
  return withOrgTransaction(actor.orgId, () =>
    db.transaction(async (tx) => {
      const project = await lockProject(actor, input.projectId, tx);
      const before = await tx.execute<Record<string, unknown>>(
        sql`select * from sov_lines where id = ${input.id} and org_id = ${actor.orgId} and project_id = ${input.projectId} for update`,
        "objects",
      );
      if (!before[0]) throw new ConstructionBillingError("Schedule line not found", 404);
      const stored = before[0];
      const used = await tx.execute(
        sql`select 1 from pay_application_lines pal
      join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
      where pal.org_id = ${actor.orgId} and pal.sov_line_id = ${input.id} and pa.status <> 'void' limit 1`,
        "objects",
      );
      const locked = used.length > 0 || stored.change_order_id != null;
      const incomeAccountId = await pinIncomeAccount(
        tx,
        actor,
        project.subsidiaryId,
        input.incomeAccountId,
      );
      if (locked) {
        const itemNo = input.itemNo == null || input.itemNo === "" ? null : String(input.itemNo);
        const storedItemNo =
          stored.item_no == null || stored.item_no === "" ? null : String(stored.item_no);
        const scheduledRaw = canonicalDecimal(input.scheduledValue, 4);
        const retainageRaw =
          input.retainagePercent == null || input.retainagePercent === ""
            ? null
            : canonicalDecimal(input.retainagePercent, 4);
        const storedRetainage =
          stored.retainage_percent == null ? null : String(stored.retainage_percent);
        const onlyIncome =
          itemNo === storedItemNo &&
          input.description.trim() === String(stored.description ?? "") &&
          scheduledRaw !== null &&
          cmp(normalizeMoney(scheduledRaw), String(stored.scheduled_value ?? "0")) === 0 &&
          (retainageRaw === null
            ? storedRetainage === null
            : storedRetainage !== null &&
              cmp(normalizeMoney(retainageRaw), storedRetainage) === 0) &&
          !(
            input.retainagePercent != null &&
            input.retainagePercent !== "" &&
            retainageRaw === null
          );
        if (!onlyIncome)
          throw new ConstructionBillingError(
            used.length
              ? "A schedule line used by an application is immutable; use a change order"
              : "A controlled schedule line is immutable; use a change order",
          );
        if ((incomeAccountId ?? null) !== (stored.income_account_id ?? null)) {
          const saved = await tx.execute(
            sql`update sov_lines set income_account_id = ${incomeAccountId}, updated_at = now(), updated_by = ${actor.actorId}
          where id = ${input.id} and org_id = ${actor.orgId} returning id`,
            "objects",
          );
          if (saved.length !== 1)
            throw new ConstructionBillingError("Schedule line changed; reload and retry", 409);
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${actor.orgId}, 'sov_lines', ${input.id}, 'income_account_update', ${JSON.stringify({ before: { incomeAccountId: stored.income_account_id }, after: { incomeAccountId } })}::jsonb, ${actor.actorId})`);
        }
        return;
      }
      const description = input.description.trim();
      const scheduledRaw = canonicalDecimal(input.scheduledValue, 4);
      if (scheduledRaw === null)
        throw new ConstructionBillingError(moneyRefusal("Scheduled value", input.scheduledValue));
      const scheduledValue = normalizeMoney(scheduledRaw);
      if (wholeDigits(scheduledValue) > 15)
        throw new ConstructionBillingError(
          "Scheduled value is out of range — at most 15 whole digits fit the ledger",
        );
      const retainageRaw =
        input.retainagePercent == null || input.retainagePercent === ""
          ? null
          : canonicalDecimal(input.retainagePercent, 4);
      if (input.retainagePercent != null && input.retainagePercent !== "" && retainageRaw === null)
        throw new ConstructionBillingError(
          moneyRefusal("Retainage percent", input.retainagePercent, "a percent"),
        );
      const retainagePercent = retainageRaw === null ? null : normalizeMoney(retainageRaw);
      if (!description || cmp(scheduledValue, "0") <= 0)
        throw new ConstructionBillingError(
          "Description and a positive scheduled value are required",
        );
      if (
        retainagePercent !== null &&
        (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0)
      )
        throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
      const after = await tx.execute<Record<string, unknown>>(
        sql`update sov_lines set item_no = ${input.itemNo ?? null}, description = ${description}, scheduled_value = ${scheduledValue},
      retainage_percent = ${retainagePercent}, income_account_id = ${incomeAccountId}, updated_at = now(), updated_by = ${actor.actorId}
      where id = ${input.id} and org_id = ${actor.orgId} and project_id = ${input.projectId} returning *`,
        "objects",
      );
      if (after.length !== 1)
        throw new ConstructionBillingError("Schedule line changed; reload and retry", 409);
      await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${actor.orgId}, 'sov_lines', ${input.id}, 'update', ${JSON.stringify({ before: stored, after: after[0] })}::jsonb, ${actor.actorId})`);
    }),
  );
}

export async function deleteConstructionSovLine(
  actor: ConstructionActor,
  projectId: string,
  id: string,
): Promise<void> {
  return withOrgTransaction(actor.orgId, () =>
    db.transaction(async (tx) => {
      await lockProject(actor, projectId, tx);
      const before = await tx.execute<Record<string, unknown>>(
        sql`select * from sov_lines where id = ${id} and org_id = ${actor.orgId} and project_id = ${projectId} for update`,
        "objects",
      );
      if (!before[0]) throw new ConstructionBillingError("Schedule line not found", 404);
      const used = await tx.execute(
        sql`select 1 from pay_application_lines pal
      join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
      where pal.org_id = ${actor.orgId} and pal.sov_line_id = ${id} and pa.status <> 'void' limit 1`,
        "objects",
      );
      if (used.length || before[0].change_order_id)
        throw new ConstructionBillingError(
          "A controlled schedule line cannot be deleted; use a reversing change order",
        );
      const deleted = await tx.execute(
        sql`delete from sov_lines where id = ${id} and org_id = ${actor.orgId} and project_id = ${projectId} returning id`,
        "objects",
      );
      if (deleted.length !== 1)
        throw new ConstructionBillingError("Schedule line changed; reload and retry", 409);
      await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${actor.orgId}, 'sov_lines', ${id}, 'delete', ${JSON.stringify({ before: before[0] })}::jsonb, ${actor.actorId})`);
    }),
  );
}

export async function createConstructionChangeOrder(
  actor: ConstructionActor,
  input: {
    projectId: string;
    number: string;
    description?: string | null;
    amount: string;
    targetSovLineId?: string | null;
    incomeAccountId?: string | null;
  },
): Promise<string> {
  const number = input.number.trim();
  const amountRaw = canonicalDecimal(input.amount, 4);
  if (amountRaw === null)
    throw new ConstructionBillingError(moneyRefusal("Change-order amount", input.amount));
  const amount = normalizeMoney(amountRaw);
  if (wholeDigits(amount) > 15)
    throw new ConstructionBillingError(
      "Change-order amount is out of range — at most 15 whole digits fit the ledger",
    );
  const targetSovLineId = input.targetSovLineId || null;
  if (targetSovLineId && !isUuid(targetSovLineId))
    throw new ConstructionBillingError("The target schedule line id must be a valid UUID");
  if (!number || cmp(amount, "0") === 0)
    throw new ConstructionBillingError("Change-order number and a non-zero amount are required");
  if (cmp(amount, "0") < 0 && !targetSovLineId)
    throw new ConstructionBillingError(
      "A deductive change order must identify the schedule line it reduces",
    );
  return withOrgTransaction(actor.orgId, () =>
    db.transaction(async (tx) => {
      await acquireFeatureGateLock(actor.orgId, tx);
      if (!(await lockAndCheckOrgFeature(tx, actor.orgId, "projects")))
        throw new ConstructionBillingError("Projects feature is disabled");
      const project = await lockProject(actor, input.projectId, tx);
      const duplicate = await tx.execute(
        sql`select 1 from change_orders where org_id = ${actor.orgId} and project_id = ${input.projectId} and number = ${number} limit 1`,
        "objects",
      );
      if (duplicate.length)
        throw new ConstructionBillingError(
          "A change order with this number already exists for this project",
        );
      if (targetSovLineId) {
        const target = await tx.execute(
          sql`select 1 from sov_lines where id = ${targetSovLineId} and org_id = ${actor.orgId} and project_id = ${input.projectId}`,
          "objects",
        );
        if (!target.length)
          throw new ConstructionBillingError(
            "The target schedule line does not belong to this project",
          );
      }
      const incomeAccountId = await pinIncomeAccount(
        tx,
        actor,
        project.subsidiaryId,
        input.incomeAccountId,
      );
      const created = await tx.execute<{ id: string }>(
        sql`insert into change_orders (org_id, project_id, number, description, amount, target_sov_line_id, income_account_id, created_by, updated_by)
      values (${actor.orgId}, ${input.projectId}, ${number}, ${input.description ?? null}, ${amount}, ${targetSovLineId}, ${incomeAccountId}, ${actor.actorId}, ${actor.actorId}) returning id`,
        "objects",
      );
      const id = created[0]?.id;
      if (!id) throw new ConstructionBillingError("Change order was not saved", 409);
      await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${actor.orgId}, 'change_orders', ${id}, 'insert', ${JSON.stringify({ after: { projectId: input.projectId, number, description: input.description ?? null, amount, targetSovLineId, incomeAccountId, status: "draft" } })}::jsonb, ${actor.actorId})`);
      return id;
    }),
  );
}

export async function voidConstructionChangeOrder(
  actor: ConstructionActor,
  projectId: string,
  id: string,
): Promise<void> {
  return withOrgTransaction(actor.orgId, () =>
    db.transaction(async (tx) => {
      await acquireFeatureGateLock(actor.orgId, tx);
      if (!(await lockAndCheckOrgFeature(tx, actor.orgId, "projects")))
        throw new ConstructionBillingError("Projects feature is disabled");
      await lockProject(actor, projectId, tx);
      const before = await tx.execute<Record<string, unknown>>(
        sql`select * from change_orders where id = ${id} and project_id = ${projectId} and org_id = ${actor.orgId} for update`,
        "objects",
      );
      if (!before[0] || before[0].status !== "draft")
        throw new ConstructionBillingError("Only a draft change order can be voided");
      const updated = await tx.execute(
        sql`update change_orders set status = 'void', updated_at = now(), updated_by = ${actor.actorId}
      where id = ${id} and project_id = ${projectId} and org_id = ${actor.orgId} and status = 'draft' returning id`,
        "objects",
      );
      if (updated.length !== 1)
        throw new ConstructionBillingError("Change order changed; reload and retry", 409);
      await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${actor.orgId}, 'change_orders', ${id}, 'void', ${JSON.stringify({ before: { status: "draft" }, after: { status: "void" } })}::jsonb, ${actor.actorId})`);
    }),
  );
}
