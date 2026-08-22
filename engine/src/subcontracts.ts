import { sql } from "drizzle-orm";
import { canonicalDecimal } from "../../web/lib/exact-decimal.ts";
import { businessToday } from "./business-date.ts";
import { db, type SqlExecutor } from "./db.ts";
import { add, cmp, mulPercent, neg, normalizeMoney, sum } from "./money.ts";

export class SubcontractError extends Error {}

/** Persist leftover create-path original commitment through exact decimal then ledger money. Fail closed. */
function persistSubcontractOriginalCommitment(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new SubcontractError("original commitment must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new SubcontractError("original commitment must be an exact decimal");
  }
}

/** Persist leftover create-path default retainage through exact decimal then ledger money. Fail closed. */
function persistSubcontractDefaultRetainage(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new SubcontractError("default retainage percent must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new SubcontractError("default retainage percent must be an exact decimal");
  }
}

/** Persist leftover SOV-line scheduled value through exact decimal then ledger money. Fail closed. */
function persistSubcontractSovScheduledValue(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new SubcontractError("scheduled value must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new SubcontractError("scheduled value must be an exact decimal");
  }
}

/** Persist leftover SOV-line retainage percent through exact decimal then ledger money. Fail closed. */
function persistSubcontractSovRetainage(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new SubcontractError("retainage percent must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new SubcontractError("retainage percent must be an exact decimal");
  }
}

/** Persist leftover change-order amount through exact decimal then ledger money. Fail closed. */
function persistSubcontractChangeOrderAmount(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new SubcontractError("change order amount must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new SubcontractError("change order amount must be an exact decimal");
  }
}

/** Persist leftover retainage-release amount through exact decimal then ledger money. Fail closed. */
function persistSubcontractRetainageReleaseAmount(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new SubcontractError("retainage release amount must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new SubcontractError("retainage release amount must be an exact decimal");
  }
}

export interface VendorApplicationLineInput {
  sovLineId: string;
  scheduledValue: string;
  previousEarned: string;
  previousMaterialsStored: string;
  workCompletedThisPeriod: string;
  materialsStoredCurrent: string;
  retainagePercent: string;
}

export interface ComputedVendorApplicationLine {
  sovLineId: string;
  grossThisPeriod: string;
  retainageThisPeriod: string;
  netDue: string;
  earnedToDate: string;
  materialsStoredCurrent: string;
  remainingCommitment: string;
}

export interface ComputedVendorApplication {
  lines: ComputedVendorApplicationLine[];
  grossThisPeriod: string;
  retainageThisPeriod: string;
  netDue: string;
}

/**
 * Exact cumulative vendor-application math. Current stored material is a
 * balance, not a new charge: a decrease is offset by work incorporated during
 * the period. This prevents paying twice when stored material becomes installed.
 */
export function computeVendorApplication(
  inputs: VendorApplicationLineInput[],
): ComputedVendorApplication {
  const lines = inputs.map((input) => {
    const scheduled = normalizeMoney(input.scheduledValue);
    const previousEarned = normalizeMoney(input.previousEarned);
    const previousStored = normalizeMoney(input.previousMaterialsStored);
    const work = normalizeMoney(input.workCompletedThisPeriod);
    const currentStored = normalizeMoney(input.materialsStoredCurrent);
    const retainagePercent = normalizeMoney(input.retainagePercent);
    if ([scheduled, previousEarned, previousStored, work, currentStored].some((value) => cmp(value, "0") < 0)) {
      throw new SubcontractError("Schedule and application amounts cannot be negative");
    }
    if (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0) {
      throw new SubcontractError("Retainage percent must be between 0 and 100");
    }
    const gross = add(add(work, currentStored), neg(previousStored));
    if (cmp(gross, "0") < 0) {
      throw new SubcontractError("A reduction in stored materials must be offset by installed work");
    }
    const earned = add(previousEarned, gross);
    if (cmp(earned, scheduled) > 0) {
      throw new SubcontractError("Application amount exceeds the revised SOV value");
    }
    const retained = cmp(gross, "0") > 0 && cmp(retainagePercent, "0") > 0
      ? mulPercent(gross, retainagePercent)
      : "0.0000";
    return {
      sovLineId: input.sovLineId,
      grossThisPeriod: gross,
      retainageThisPeriod: retained,
      netDue: add(gross, neg(retained)),
      earnedToDate: earned,
      materialsStoredCurrent: currentStored,
      remainingCommitment: add(scheduled, neg(earned)),
    };
  });
  const grossThisPeriod = lines.length ? sum(lines.map((line) => line.grossThisPeriod)) : "0.0000";
  const retainageThisPeriod = lines.length ? sum(lines.map((line) => line.retainageThisPeriod)) : "0.0000";
  return {
    lines,
    grossThisPeriod,
    retainageThisPeriod,
    netDue: add(grossThisPeriod, neg(retainageThisPeriod)),
  };
}

/** Deductive changes may never reduce a line below earned-to-date. */
export function revisedSubcontractSovValue(
  currentScheduledValue: string,
  changeAmount: string,
  earnedToDate: string,
): string {
  const revised = add(normalizeMoney(currentScheduledValue), normalizeMoney(changeAmount));
  if (cmp(revised, "0") <= 0 || cmp(revised, normalizeMoney(earnedToDate)) < 0) {
    throw new SubcontractError("The change would reduce the SOV line below its earned value");
  }
  return revised;
}

async function assertFeatureEnabled(tx: SqlExecutor, orgId: string): Promise<void> {
  const result = (await tx.execute<{ projects: boolean; subcontracts: boolean }>(sql`
    select coalesce((settings->'features'->>'projects')::boolean, true) as projects,
           coalesce((settings->'features'->>'subcontracts')::boolean, false) as subcontracts
      from orgs where id = ${orgId}
  `));
  const row = result.rows[0];
  if (!row?.projects) throw new SubcontractError("Projects feature is disabled");
  if (!row.subcontracts) throw new SubcontractError("Subcontracts feature is disabled");
}

async function audit(
  tx: SqlExecutor,
  orgId: string,
  table: string,
  rowId: string,
  action: string,
  changes: unknown,
  actorId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
}

async function nextDocumentNumber(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string | null,
  prefix: string,
): Promise<string> {
  const configured = subsidiaryId
    ? ((await tx.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = 'vendor_bill'
          and subsidiary_id = ${subsidiaryId} limit 1
      `))).rows.length > 0
    : false;
  const sequenceSubsidiary = configured ? subsidiaryId : null;
  const result = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, 'vendor_bill', ${sequenceSubsidiary}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `));
  const row = result.rows[0]!;
  return `${row.prefix}${String(row.next_number).padStart(row.padding, "0")}`;
}

export async function createSubcontract(input: {
  orgId: string;
  userId: string;
  projectId: string;
  vendorId: string;
  number: string;
  title: string;
  description?: string | null;
  currency?: string | null;
  originalCommitment: string;
  defaultRetainagePercent?: string;
  purchaseOrderId?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}): Promise<{ id: string }> {
  const number = input.number.trim();
  const title = input.title.trim();
  const original = persistSubcontractOriginalCommitment(input.originalCommitment);
  const retainage = persistSubcontractDefaultRetainage(input.defaultRetainagePercent ?? "10");
  if (!number || !title || cmp(original, "0") <= 0) {
    throw new SubcontractError("Number, title, and a positive original commitment are required");
  }
  if (cmp(retainage, "0") < 0 || cmp(retainage, "100") > 0) {
    throw new SubcontractError("Retainage percent must be between 0 and 100");
  }
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    throw new SubcontractError("End date cannot precede start date");
  }
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const scope = (await tx.execute<{ currency: string | null; vendor_ok: boolean; po_ok: boolean }>(sql`
      select p.subsidiary_id,
             coalesce(${input.currency ?? null}, vr.currency, s.base_currency, o.base_currency) as currency,
             exists(select 1 from vendor_roles vr2 where vr2.org_id = p.org_id and vr2.party_id = ${input.vendorId} and vr2.is_active) as vendor_ok,
             (${input.purchaseOrderId ?? null}::uuid is null or exists(
               select 1 from documents d where d.org_id = p.org_id and d.id = ${input.purchaseOrderId ?? null}
                 and d.kind = 'purchase_order' and d.project_id = p.id and d.party_id = ${input.vendorId}
             )) as po_ok
        from projects p join orgs o on o.id = p.org_id
        left join subsidiaries s on s.id = p.subsidiary_id and s.org_id = p.org_id
        left join vendor_roles vr on vr.org_id = p.org_id and vr.party_id = ${input.vendorId}
       where p.org_id = ${input.orgId} and p.id = ${input.projectId} and p.is_active
    `));
    const row = scope.rows[0];
    if (!row) throw new SubcontractError("Project not found");
    if (!row.vendor_ok) throw new SubcontractError("Vendor is not active in this organization");
    if (!row.po_ok) throw new SubcontractError("Purchase order does not belong to this project and vendor");
    if (!row.currency) throw new SubcontractError("A transaction currency is required");
    const result = (await tx.execute<{ id: string }>(sql`
      insert into subcontracts (
        org_id, project_id, vendor_id, number, title, description, currency,
        original_commitment, default_retainage_percent, purchase_order_id,
        starts_on, ends_on, created_by, updated_by
      ) values (
        ${input.orgId}, ${input.projectId}, ${input.vendorId}, ${number}, ${title},
        ${input.description ?? null}, ${row.currency}, ${original}, ${retainage},
        ${input.purchaseOrderId ?? null}, ${input.startsOn ?? null}, ${input.endsOn ?? null},
        ${input.userId}, ${input.userId}
      ) returning id
    `));
    const id = result.rows[0]!.id;
    await audit(tx, input.orgId, "subcontracts", id, "insert", {
      after: { projectId: input.projectId, vendorId: input.vendorId, number, title, originalCommitment: original },
    }, input.userId);
    return { id };
  });
}

export async function updateDraftSubcontract(input: {
  orgId: string;
  userId: string;
  id: string;
  title: string;
  description?: string | null;
  originalCommitment: string;
  defaultRetainagePercent: string;
  startsOn?: string | null;
  endsOn?: string | null;
}): Promise<void> {
  const title = input.title.trim();
  const original = persistSubcontractOriginalCommitment(input.originalCommitment);
  const retainage = persistSubcontractDefaultRetainage(input.defaultRetainagePercent);
  if (!title || cmp(original, "0") <= 0) throw new SubcontractError("Title and a positive commitment are required");
  if (cmp(retainage, "0") < 0 || cmp(retainage, "100") > 0) throw new SubcontractError("Retainage percent must be between 0 and 100");
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const before = (await tx.execute<any>(sql`select * from subcontracts where org_id = ${input.orgId} and id = ${input.id} for update`));
    if (!before.rows[0]) throw new SubcontractError("Subcontract not found");
    if (before.rows[0].status !== "draft") throw new SubcontractError("Only a draft subcontract can be edited");
    const after = (await tx.execute<any>(sql`
      update subcontracts set title = ${title}, description = ${input.description ?? null}, original_commitment = ${original},
        default_retainage_percent = ${retainage}, starts_on = ${input.startsOn ?? null}, ends_on = ${input.endsOn ?? null},
        updated_at = now(), updated_by = ${input.userId}
      where org_id = ${input.orgId} and id = ${input.id} returning *
    `));
    await audit(tx, input.orgId, "subcontracts", input.id, "update", { before: before.rows[0], after: after.rows[0] }, input.userId);
  });
}

export async function addSubcontractSovLine(input: {
  orgId: string;
  userId: string;
  subcontractId: string;
  itemNo?: string | null;
  description: string;
  scheduledValue: string;
  retainagePercent?: string | null;
  expenseAccountId?: string | null;
  sortOrder?: number;
}): Promise<{ id: string }> {
  const description = input.description.trim();
  const value = persistSubcontractSovScheduledValue(input.scheduledValue);
  const retainage = input.retainagePercent == null || input.retainagePercent === ""
    ? null
    : persistSubcontractSovRetainage(input.retainagePercent);
  if (!description || cmp(value, "0") <= 0) throw new SubcontractError("Description and positive scheduled value are required");
  if (retainage !== null && (cmp(retainage, "0") < 0 || cmp(retainage, "100") > 0)) throw new SubcontractError("Retainage percent must be between 0 and 100");
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const owner = (await tx.execute<{ status: string }>(sql`select status from subcontracts where org_id = ${input.orgId} and id = ${input.subcontractId} for update`));
    if (!owner.rows[0]) throw new SubcontractError("Subcontract not found");
    if (owner.rows[0].status !== "draft") throw new SubcontractError("An active subcontract can only change through an approved change order");
    if (input.expenseAccountId) {
      const account = (await tx.execute(sql`select 1 from accounts where org_id = ${input.orgId} and id = ${input.expenseAccountId} and is_active and not is_summary`));
      if (!account.rows.length) throw new SubcontractError("Expense account not found");
    }
    const result = (await tx.execute<{ id: string }>(sql`
      insert into subcontract_sov_lines (org_id, subcontract_id, item_no, description, scheduled_value,
        retainage_percent, expense_account_id, sort_order, created_by, updated_by)
      values (${input.orgId}, ${input.subcontractId}, ${input.itemNo ?? null}, ${description}, ${value},
        ${retainage}, ${input.expenseAccountId ?? null}, ${input.sortOrder ?? 0}, ${input.userId}, ${input.userId}) returning id
    `));
    const id = result.rows[0]!.id;
    await audit(tx, input.orgId, "subcontract_sov_lines", id, "insert", { after: { ...input, scheduledValue: value } }, input.userId);
    return { id };
  });
}

export async function removeSubcontractSovLine(orgId: string, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const row = (await tx.execute<any>(sql`
      select l.*, s.status from subcontract_sov_lines l join subcontracts s on s.id = l.subcontract_id and s.org_id = l.org_id
      where l.org_id = ${orgId} and l.id = ${id} for update
    `));
    if (!row.rows[0]) throw new SubcontractError("SOV line not found");
    if (row.rows[0].status !== "draft" || row.rows[0].change_order_id) throw new SubcontractError("A controlled SOV line cannot be deleted");
    await tx.execute(sql`delete from subcontract_sov_lines where org_id = ${orgId} and id = ${id}`);
    await audit(tx, orgId, "subcontract_sov_lines", id, "delete", { before: row.rows[0] }, userId);
  });
}

export async function submitSubcontract(orgId: string, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const row = (await tx.execute<{ status: string; original_commitment: string; sov_total: string }>(sql`
      select s.status, s.original_commitment,
             coalesce((select sum(l.scheduled_value) from subcontract_sov_lines l
               where l.org_id = s.org_id and l.subcontract_id = s.id), 0) as sov_total
        from subcontracts s where s.org_id = ${orgId} and s.id = ${id} for update
    `));
    const contract = row.rows[0];
    if (!contract) throw new SubcontractError("Subcontract not found");
    if (contract.status !== "draft") throw new SubcontractError("Only a draft subcontract can be submitted");
    if (cmp(contract.original_commitment, "0") <= 0 || cmp(contract.sov_total, contract.original_commitment) !== 0) {
      throw new SubcontractError("The vendor SOV must equal the original commitment before submission");
    }
    await tx.execute(sql`update subcontracts set status = 'pending_approval', submitted_at = now(), submitted_by = ${userId}, updated_at = now(), updated_by = ${userId} where org_id = ${orgId} and id = ${id}`);
    await audit(tx, orgId, "subcontracts", id, "submit", { after: { status: "pending_approval", sovTotal: contract.sov_total } }, userId);
  });
}

export async function approveSubcontract(orgId: string, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const row = (await tx.execute<{ status: string; submitted_by: string | null; created_by: string | null }>(sql`select status, submitted_by, created_by from subcontracts where org_id = ${orgId} and id = ${id} for update`));
    const contract = row.rows[0];
    if (!contract) throw new SubcontractError("Subcontract not found");
    if (contract.status !== "pending_approval") throw new SubcontractError("Subcontract is not awaiting approval");
    if ((contract.submitted_by ?? contract.created_by) === userId) throw new SubcontractError("The submitter cannot approve this subcontract");
    await tx.execute(sql`update subcontracts set status = 'active', approved_at = now(), approved_by = ${userId}, updated_at = now(), updated_by = ${userId} where org_id = ${orgId} and id = ${id}`);
    await audit(tx, orgId, "subcontracts", id, "approve", { after: { status: "active" } }, userId);
  });
}

export async function transitionSubcontract(input: {
  orgId: string;
  userId: string;
  id: string;
  action: "substantially_complete" | "close" | "void";
}): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const row = (await tx.execute<{ status: string }>(sql`select status from subcontracts where org_id = ${input.orgId} and id = ${input.id} for update`));
    const status = row.rows[0]?.status;
    if (!status) throw new SubcontractError("Subcontract not found");
    const next = input.action === "substantially_complete" ? "substantially_complete" : input.action === "close" ? "closed" : "void";
    const allowed = input.action === "substantially_complete" ? status === "active"
      : input.action === "close" ? status === "substantially_complete"
        : ["draft", "pending_approval"].includes(status);
    if (!allowed) throw new SubcontractError(`Cannot ${input.action.replace("_", " ")} a ${status} subcontract`);
    if (next === "closed") {
      const open = (await tx.execute(sql`select 1 from vendor_pay_applications where org_id = ${input.orgId} and subcontract_id = ${input.id} and status in ('draft','submitted','approved') limit 1`));
      if (open.rows.length) throw new SubcontractError("Complete or void open vendor applications before closing");
    }
    await tx.execute(sql`update subcontracts set status = ${next}, closed_at = case when ${next} = 'closed' then now() else closed_at end, closed_by = case when ${next} = 'closed' then ${input.userId} else closed_by end, updated_at = now(), updated_by = ${input.userId} where org_id = ${input.orgId} and id = ${input.id}`);
    await audit(tx, input.orgId, "subcontracts", input.id, input.action, { before: { status }, after: { status: next } }, input.userId);
  });
}

export async function createSubcontractChangeOrder(input: {
  orgId: string;
  userId: string;
  subcontractId: string;
  number: string;
  description?: string | null;
  amount: string;
  targetSovLineId?: string | null;
}): Promise<{ id: string }> {
  const number = input.number.trim();
  const amount = persistSubcontractChangeOrderAmount(input.amount);
  if (!number || cmp(amount, "0") === 0) throw new SubcontractError("Number and a non-zero change amount are required");
  if (cmp(amount, "0") < 0 && !input.targetSovLineId) throw new SubcontractError("A deductive change must identify the SOV line it reduces");
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const contract = (await tx.execute<{ status: string }>(sql`select status from subcontracts where org_id = ${input.orgId} and id = ${input.subcontractId} for update`));
    if (!contract.rows[0] || !["active", "substantially_complete"].includes(contract.rows[0].status)) throw new SubcontractError("Only an active subcontract can receive a change order");
    if (input.targetSovLineId) {
      const target = (await tx.execute(sql`select 1 from subcontract_sov_lines where org_id = ${input.orgId} and subcontract_id = ${input.subcontractId} and id = ${input.targetSovLineId}`));
      if (!target.rows.length) throw new SubcontractError("Target SOV line does not belong to this subcontract");
    }
    const result = (await tx.execute<{ id: string }>(sql`
      insert into subcontract_change_orders (org_id, subcontract_id, number, description, amount, target_sov_line_id, created_by, updated_by)
      values (${input.orgId}, ${input.subcontractId}, ${number}, ${input.description ?? null}, ${amount}, ${input.targetSovLineId ?? null}, ${input.userId}, ${input.userId}) returning id
    `));
    const id = result.rows[0]!.id;
    await audit(tx, input.orgId, "subcontract_change_orders", id, "insert", { after: { ...input, amount } }, input.userId);
    return { id };
  });
}

export async function approveSubcontractChangeOrder(orgId: string, userId: string, id: string, approvedOn: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const result = (await tx.execute<any>(sql`
      select co.*, s.project_id from subcontract_change_orders co
      join subcontracts s on s.id = co.subcontract_id and s.org_id = co.org_id
      where co.org_id = ${orgId} and co.id = ${id} for update of co, s
    `));
    const change = result.rows[0];
    if (!change) throw new SubcontractError("Change order not found");
    if (change.status !== "draft") throw new SubcontractError("Only a draft change order can be approved");
    if (change.created_by === userId) throw new SubcontractError("The change-order creator cannot approve it");
    if (change.target_sov_line_id) {
      const line = (await tx.execute<{ scheduled_value: string; earned: string }>(sql`
        select l.scheduled_value,
          coalesce((select max(vpal.previous_earned + vpal.work_completed_this_period + vpal.materials_stored_current - vpal.previous_materials_stored)
            from vendor_pay_application_lines vpal join vendor_pay_applications vpa on vpa.id = vpal.pay_application_id and vpa.org_id = vpal.org_id
            where vpal.org_id = ${orgId} and vpal.sov_line_id = l.id and vpa.status in ('billed','approved')), 0) as earned
        from subcontract_sov_lines l where l.org_id = ${orgId} and l.subcontract_id = ${change.subcontract_id} and l.id = ${change.target_sov_line_id} for update
      `));
      if (!line.rows[0]) throw new SubcontractError("Target SOV line not found");
      const revised = revisedSubcontractSovValue(line.rows[0].scheduled_value, change.amount, line.rows[0].earned);
      await tx.execute(sql`update subcontract_sov_lines set scheduled_value = ${revised}, updated_at = now(), updated_by = ${userId} where org_id = ${orgId} and id = ${change.target_sov_line_id}`);
    } else {
      await tx.execute(sql`
        insert into subcontract_sov_lines (org_id, subcontract_id, item_no, description, scheduled_value, sort_order, change_order_id, created_by, updated_by)
        values (${orgId}, ${change.subcontract_id}, ${change.number}, coalesce(${change.description}, 'Change order ' || ${change.number}), ${change.amount},
          (select coalesce(max(sort_order), 0) + 1 from subcontract_sov_lines where org_id = ${orgId} and subcontract_id = ${change.subcontract_id}),
          ${id}, ${userId}, ${userId})
      `);
    }
    await tx.execute(sql`update subcontract_change_orders set status = 'approved', approved_on = ${approvedOn}, approved_at = now(), approved_by = ${userId}, updated_at = now(), updated_by = ${userId} where org_id = ${orgId} and id = ${id}`);
    await audit(tx, orgId, "subcontract_change_orders", id, "approve", { after: { status: "approved", approvedOn } }, userId);
  });
}

export async function voidSubcontractChangeOrder(orgId: string, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const result = await tx.execute(sql`update subcontract_change_orders set status = 'void', updated_at = now(), updated_by = ${userId} where org_id = ${orgId} and id = ${id} and status = 'draft' returning id`);
    if (!(result as any).rows[0]) throw new SubcontractError("Only a draft change order can be voided");
    await audit(tx, orgId, "subcontract_change_orders", id, "void", { after: { status: "void" } }, userId);
  });
}

export async function createVendorPayApplication(input: {
  orgId: string;
  userId: string;
  subcontractId: string;
  periodEnd: string;
  vendorInvoiceNumber?: string | null;
}): Promise<{ id: string; applicationNumber: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd)) throw new SubcontractError("Valid period-ending date is required");
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const contract = (await tx.execute<{ status: string; default_retainage_percent: string }>(sql`select status, default_retainage_percent from subcontracts where org_id = ${input.orgId} and id = ${input.subcontractId} for update`));
    if (!contract.rows[0] || !["active", "substantially_complete"].includes(contract.rows[0].status)) throw new SubcontractError("Subcontract is not active");
    const lifecycle = (await tx.execute<{ has_open: boolean; next_number: number; last_period: string | null }>(sql`
      select exists(select 1 from vendor_pay_applications where org_id = ${input.orgId} and subcontract_id = ${input.subcontractId} and status in ('draft','submitted','approved')) as has_open,
             coalesce(max(application_number), 0) + 1 as next_number,
             max(period_end) filter (where status = 'billed') as last_period
        from vendor_pay_applications where org_id = ${input.orgId} and subcontract_id = ${input.subcontractId}
    `));
    if (lifecycle.rows[0]!.has_open) throw new SubcontractError("Complete or void the open vendor application first");
    if (lifecycle.rows[0]!.last_period && input.periodEnd <= lifecycle.rows[0]!.last_period!) throw new SubcontractError("Period ending must follow the last billed application");
    const number = Number(lifecycle.rows[0]!.next_number);
    const created = (await tx.execute<{ id: string }>(sql`
      insert into vendor_pay_applications (org_id, subcontract_id, application_number, period_end, vendor_invoice_number,
        default_retainage_percent, created_by, updated_by)
      values (${input.orgId}, ${input.subcontractId}, ${number}, ${input.periodEnd}, ${input.vendorInvoiceNumber ?? null},
        ${contract.rows[0]!.default_retainage_percent}, ${input.userId}, ${input.userId}) returning id
    `));
    const id = created.rows[0]!.id;
    await tx.execute(sql`
      insert into vendor_pay_application_lines (
        org_id, pay_application_id, sov_line_id, previous_earned, previous_materials_stored,
        retainage_percent, created_by, updated_by
      )
      select ${input.orgId}, ${id}, sov.id,
             coalesce(prior.earned, 0), coalesce(prior.materials_stored, 0),
             coalesce(sov.retainage_percent, ${contract.rows[0]!.default_retainage_percent}), ${input.userId}, ${input.userId}
        from subcontract_sov_lines sov
        left join lateral (
          select (vpal.previous_earned + vpal.work_completed_this_period + vpal.materials_stored_current - vpal.previous_materials_stored) as earned,
                 vpal.materials_stored_current as materials_stored
            from vendor_pay_application_lines vpal
            join vendor_pay_applications vpa on vpa.id = vpal.pay_application_id and vpa.org_id = vpal.org_id
           where vpal.org_id = ${input.orgId} and vpal.sov_line_id = sov.id and vpa.status = 'billed'
           order by vpa.application_number desc limit 1
        ) prior on true
       where sov.org_id = ${input.orgId} and sov.subcontract_id = ${input.subcontractId}
       order by sov.sort_order
    `);
    await audit(tx, input.orgId, "vendor_pay_applications", id, "insert", { after: { subcontractId: input.subcontractId, applicationNumber: number, periodEnd: input.periodEnd } }, input.userId);
    return { id, applicationNumber: number };
  });
}

export async function updateVendorPayApplicationLines(input: {
  orgId: string;
  userId: string;
  payApplicationId: string;
  lines: Array<{ sovLineId: string; workCompletedThisPeriod: string; materialsStoredCurrent: string }>;
}): Promise<ComputedVendorApplication> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const app = (await tx.execute<{ status: string }>(sql`select status from vendor_pay_applications where org_id = ${input.orgId} and id = ${input.payApplicationId} for update`));
    if (!app.rows[0]) throw new SubcontractError("Vendor application not found");
    if (app.rows[0].status !== "draft") throw new SubcontractError("Only a draft application can be edited");
    for (const update of input.lines) {
      const work = normalizeMoney(update.workCompletedThisPeriod);
      const stored = normalizeMoney(update.materialsStoredCurrent);
      if (cmp(work, "0") < 0 || cmp(stored, "0") < 0) throw new SubcontractError("Application amounts cannot be negative");
      const changed = (await tx.execute(sql`
        update vendor_pay_application_lines set work_completed_this_period = ${work}, materials_stored_current = ${stored},
          updated_at = now(), updated_by = ${input.userId}
        where org_id = ${input.orgId} and pay_application_id = ${input.payApplicationId} and sov_line_id = ${update.sovLineId}
        returning id
      `));
      if (!changed.rows.length) throw new SubcontractError("Application line does not belong to this application");
    }
    const computed = await computeApplicationTx(tx, input.orgId, input.payApplicationId);
    await audit(tx, input.orgId, "vendor_pay_applications", input.payApplicationId, "update_lines", { computed }, input.userId);
    return computed;
  });
}

async function computeApplicationTx(tx: SqlExecutor, orgId: string, payApplicationId: string): Promise<ComputedVendorApplication> {
  const result = (await tx.execute<any>(sql`
    select l.sov_line_id, s.scheduled_value, l.previous_earned, l.previous_materials_stored,
           l.work_completed_this_period, l.materials_stored_current, l.retainage_percent
      from vendor_pay_application_lines l
      join subcontract_sov_lines s on s.id = l.sov_line_id and s.org_id = l.org_id
     where l.org_id = ${orgId} and l.pay_application_id = ${payApplicationId}
     order by s.sort_order
  `));
  if (!result.rows.length) throw new SubcontractError("Vendor application has no SOV lines");
  return computeVendorApplication(result.rows.map((row) => ({
    sovLineId: row.sov_line_id,
    scheduledValue: row.scheduled_value,
    previousEarned: row.previous_earned,
    previousMaterialsStored: row.previous_materials_stored,
    workCompletedThisPeriod: row.work_completed_this_period,
    materialsStoredCurrent: row.materials_stored_current,
    retainagePercent: row.retainage_percent,
  })));
}

export async function submitVendorPayApplication(orgId: string, userId: string, id: string): Promise<ComputedVendorApplication> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const app = (await tx.execute<{ status: string }>(sql`select status from vendor_pay_applications where org_id = ${orgId} and id = ${id} for update`));
    if (!app.rows[0]) throw new SubcontractError("Vendor application not found");
    if (app.rows[0].status !== "draft") throw new SubcontractError("Only a draft application can be submitted");
    const computed = await computeApplicationTx(tx, orgId, id);
    if (cmp(computed.grossThisPeriod, "0") <= 0) throw new SubcontractError("Application must request a positive amount");
    await tx.execute(sql`
      update vendor_pay_applications set status = 'submitted', gross_this_period = ${computed.grossThisPeriod},
        retainage_this_period = ${computed.retainageThisPeriod}, net_due = ${computed.netDue}, submitted_at = now(),
        submitted_by = ${userId}, updated_at = now(), updated_by = ${userId}
      where org_id = ${orgId} and id = ${id}
    `);
    await audit(tx, orgId, "vendor_pay_applications", id, "submit", { after: computed }, userId);
    return computed;
  });
}

export async function approveVendorPayApplication(orgId: string, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const app = (await tx.execute<{ status: string; submitted_by: string | null; created_by: string | null }>(sql`select status, submitted_by, created_by from vendor_pay_applications where org_id = ${orgId} and id = ${id} for update`));
    if (!app.rows[0]) throw new SubcontractError("Vendor application not found");
    if (app.rows[0].status !== "submitted") throw new SubcontractError("Application is not awaiting approval");
    if ((app.rows[0].submitted_by ?? app.rows[0].created_by) === userId) throw new SubcontractError("The submitter cannot approve this vendor application");
    await tx.execute(sql`update vendor_pay_applications set status = 'approved', approved_at = now(), approved_by = ${userId}, updated_at = now(), updated_by = ${userId} where org_id = ${orgId} and id = ${id}`);
    await audit(tx, orgId, "vendor_pay_applications", id, "approve", { after: { status: "approved" } }, userId);
  });
}

export async function voidVendorPayApplication(orgId: string, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const result = (await tx.execute(sql`
      update vendor_pay_applications set status = 'void', updated_at = now(), updated_by = ${userId}
      where org_id = ${orgId} and id = ${id} and status in ('draft','submitted','approved') and vendor_bill_document_id is null returning id
    `));
    if (!result.rows.length) throw new SubcontractError("A billed or void application cannot be voided here");
    await audit(tx, orgId, "vendor_pay_applications", id, "void", { after: { status: "void" } }, userId);
  });
}

export async function generateVendorPayApplicationBill(
  orgId: string,
  userId: string,
  id: string,
): Promise<{ vendorBillDocumentId: string; documentNumber: string; netDue: string }> {
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const result = (await tx.execute<any>(sql`
      select vpa.*, s.project_id, s.vendor_id, s.currency, p.subsidiary_id
        from vendor_pay_applications vpa
        join subcontracts s on s.id = vpa.subcontract_id and s.org_id = vpa.org_id
        join projects p on p.id = s.project_id and p.org_id = s.org_id
       where vpa.org_id = ${orgId} and vpa.id = ${id} for update of vpa
    `));
    const app = result.rows[0];
    if (!app) throw new SubcontractError("Vendor application not found");
    if (app.vendor_bill_document_id) {
      const document = (await tx.execute<{ document_number: string }>(sql`select document_number from documents where org_id = ${orgId} and id = ${app.vendor_bill_document_id}`));
      return { vendorBillDocumentId: app.vendor_bill_document_id, documentNumber: document.rows[0]!.document_number, netDue: app.net_due };
    }
    if (app.status !== "approved") throw new SubcontractError("Only an approved vendor application can create a bill");
    const retainageAccount = (await tx.execute<{ id: string | null }>(sql`select settings->'controlAccounts'->>'retainagePayable' as id from orgs where id = ${orgId}`));
    if (cmp(app.retainage_this_period, "0") > 0 && !retainageAccount.rows[0]?.id) throw new SubcontractError("Retainage Payable control account is not configured");
    const computed = await computeApplicationTx(tx, orgId, id);
    if (cmp(computed.grossThisPeriod, app.gross_this_period) !== 0 || cmp(computed.netDue, app.net_due) !== 0) {
      throw new SubcontractError("Approved application evidence no longer agrees with its frozen totals");
    }
    const detail = (await tx.execute<{ description: string; gross: string; account_id: string | null }>(sql`
      select l.sov_line_id, sov.description, sov.expense_account_id,
             (l.work_completed_this_period + l.materials_stored_current - l.previous_materials_stored)::text as gross,
             coalesce(sov.expense_account_id, vr.default_expense_account_id,
               (select id from accounts where org_id = ${orgId} and is_active and not is_summary and type in ('expense','cogs') order by number nulls last limit 1)) as account_id
        from vendor_pay_application_lines l
        join subcontract_sov_lines sov on sov.id = l.sov_line_id and sov.org_id = l.org_id
        join subcontracts s on s.id = sov.subcontract_id and s.org_id = sov.org_id
        left join vendor_roles vr on vr.org_id = s.org_id and vr.party_id = s.vendor_id
       where l.org_id = ${orgId} and l.pay_application_id = ${id}
       order by sov.sort_order
    `));
    if (detail.rows.some((row) => cmp(row.gross, "0") > 0 && !row.account_id)) throw new SubcontractError("Every billed SOV line requires an expense account");
    const documentNumber = await nextDocumentNumber(tx, orgId, app.subsidiary_id ?? null, "BILL-");
    const document = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, currency, status,
        project_id, subsidiary_id, reference_number, memo, subtotal, tax_total, total, custom, created_by, updated_by)
      values (${orgId}, 'vendor_bill', ${documentNumber}, ${app.vendor_id}, ${app.period_end}, ${app.currency}, 'draft',
        ${app.project_id}, ${app.subsidiary_id}, ${app.vendor_invoice_number}, ${`Subcontract application #${app.application_number}`},
        ${app.net_due}, '0', ${app.net_due}, ${JSON.stringify({ subcontractId: app.subcontract_id, vendorPayApplicationId: id })}::jsonb,
        ${userId}, ${userId}) returning id
    `));
    const vendorBillDocumentId = document.rows[0]!.id;
    let lineNumber = 1;
    for (const line of detail.rows) {
      const amount = normalizeMoney(line.gross);
      if (cmp(amount, "0") === 0) continue;
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description, quantity, unit_price,
          amount, project_id, party_id, is_billable, created_by, updated_by)
        values (${orgId}, ${vendorBillDocumentId}, ${lineNumber++}, ${line.account_id}, ${line.description}, '1', ${amount},
          ${amount}, ${app.project_id}, ${app.vendor_id}, false, ${userId}, ${userId})
      `);
    }
    if (cmp(app.retainage_this_period, "0") > 0) {
      const withheld = neg(app.retainage_this_period);
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description, quantity, unit_price,
          amount, project_id, party_id, is_billable, created_by, updated_by)
        values (${orgId}, ${vendorBillDocumentId}, ${lineNumber}, ${retainageAccount.rows[0]!.id}, 'Retainage withheld', '1', ${withheld},
          ${withheld}, ${app.project_id}, ${app.vendor_id}, false, ${userId}, ${userId})
      `);
    }
    await tx.execute(sql`update vendor_pay_applications set status = 'billed', vendor_bill_document_id = ${vendorBillDocumentId}, updated_at = now(), updated_by = ${userId} where org_id = ${orgId} and id = ${id}`);
    await audit(tx, orgId, "vendor_pay_applications", id, "create_vendor_bill", { after: { vendorBillDocumentId, documentNumber, netDue: app.net_due } }, userId);
    return { vendorBillDocumentId, documentNumber, netDue: app.net_due };
  });
}

export async function releaseVendorRetainage(input: {
  orgId: string;
  userId: string;
  subcontractId: string;
  periodEnd: string;
  amount: string;
  memo?: string | null;
}): Promise<{ vendorBillDocumentId: string; documentNumber: string; amount: string }> {
  const amount = persistSubcontractRetainageReleaseAmount(input.amount);
  if (cmp(amount, "0") <= 0) throw new SubcontractError("Release amount must be positive");
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const contract = (await tx.execute<any>(sql`
      select s.project_id, s.vendor_id, s.currency, s.status, p.subsidiary_id
        from subcontracts s join projects p on p.id = s.project_id and p.org_id = s.org_id
       where s.org_id = ${input.orgId} and s.id = ${input.subcontractId} for update of s
    `));
    const row = contract.rows[0];
    if (!row || !["active", "substantially_complete", "closed"].includes(row.status)) throw new SubcontractError("Subcontract not found or cannot release retainage");
    const retainageAccount = (await tx.execute<{ id: string | null }>(sql`select settings->'controlAccounts'->>'retainagePayable' as id from orgs where id = ${input.orgId}`));
    if (!retainageAccount.rows[0]?.id) throw new SubcontractError("Retainage Payable control account is not configured");
    const balance = (await tx.execute<{ held: string; released: string }>(sql`
      select coalesce(sum(case when d.status = 'posted' then vpa.retainage_this_period else 0 end), 0) as held,
             coalesce((select sum(vrr.amount) from vendor_retainage_releases vrr join documents rd on rd.id = vrr.vendor_bill_document_id and rd.org_id = vrr.org_id
               where vrr.org_id = ${input.orgId} and vrr.subcontract_id = ${input.subcontractId} and rd.status <> 'voided'), 0) as released
        from vendor_pay_applications vpa left join documents d on d.id = vpa.vendor_bill_document_id and d.org_id = vpa.org_id
       where vpa.org_id = ${input.orgId} and vpa.subcontract_id = ${input.subcontractId} and vpa.status = 'billed'
    `));
    const available = add(balance.rows[0]?.held ?? "0", neg(balance.rows[0]?.released ?? "0"));
    if (cmp(amount, available) > 0) throw new SubcontractError("Release exceeds posted retainage currently held");
    const documentNumber = await nextDocumentNumber(tx, input.orgId, row.subsidiary_id ?? null, "BILL-");
    const document = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, currency, status,
        project_id, subsidiary_id, memo, subtotal, tax_total, total, custom, created_by, updated_by)
      values (${input.orgId}, 'vendor_bill', ${documentNumber}, ${row.vendor_id}, ${input.periodEnd}, ${row.currency}, 'draft',
        ${row.project_id}, ${row.subsidiary_id}, ${input.memo ?? "Subcontract retainage release"}, ${amount}, '0', ${amount},
        ${JSON.stringify({ subcontractId: input.subcontractId, kind: "retainage_release" })}::jsonb, ${input.userId}, ${input.userId}) returning id
    `));
    const vendorBillDocumentId = document.rows[0]!.id;
    await tx.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description, quantity, unit_price,
        amount, project_id, party_id, is_billable, created_by, updated_by)
      values (${input.orgId}, ${vendorBillDocumentId}, 1, ${retainageAccount.rows[0]!.id}, 'Retainage release', '1', ${amount},
        ${amount}, ${row.project_id}, ${row.vendor_id}, false, ${input.userId}, ${input.userId})
    `);
    const release = (await tx.execute<{ id: string }>(sql`
      insert into vendor_retainage_releases (org_id, subcontract_id, period_end, amount, vendor_bill_document_id, memo, created_by, updated_by)
      values (${input.orgId}, ${input.subcontractId}, ${input.periodEnd}, ${amount}, ${vendorBillDocumentId}, ${input.memo ?? null}, ${input.userId}, ${input.userId}) returning id
    `));
    await audit(tx, input.orgId, "vendor_retainage_releases", release.rows[0]!.id, "insert", { after: { amount, vendorBillDocumentId, documentNumber, availableBefore: available } }, input.userId);
    return { vendorBillDocumentId, documentNumber, amount };
  });
}

export async function createSubcontractPaymentControl(input: {
  orgId: string;
  userId: string;
  subcontractId: string;
  payApplicationId?: string | null;
  vendorBillDocumentId?: string | null;
  controlType: "joint_check" | "payment_hold";
  jointPayeePartyId?: string | null;
  amountLimit?: string | null;
  reason: string;
  effectiveOn: string;
  expiresOn?: string | null;
}): Promise<{ id: string }> {
  const reason = input.reason.trim();
  const amountLimit = input.amountLimit ? normalizeMoney(input.amountLimit) : null;
  if (!reason) throw new SubcontractError("A payment-control reason is required");
  if (input.controlType === "joint_check" && !input.jointPayeePartyId) throw new SubcontractError("Joint checks require a joint payee");
  if (input.controlType === "payment_hold" && input.jointPayeePartyId) throw new SubcontractError("Payment holds do not have a joint payee");
  if (amountLimit && cmp(amountLimit, "0") <= 0) throw new SubcontractError("Amount limit must be positive");
  return db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, input.orgId);
    const scope = (await tx.execute<{ subcontract_ok: boolean; payee_ok: boolean; app_ok: boolean; bill_ok: boolean }>(sql`
      select exists(select 1 from subcontracts where org_id = ${input.orgId} and id = ${input.subcontractId}) as subcontract_ok,
             (${input.jointPayeePartyId ?? null}::uuid is null or exists(select 1 from parties where org_id = ${input.orgId} and id = ${input.jointPayeePartyId ?? null} and is_active)) as payee_ok,
             (${input.payApplicationId ?? null}::uuid is null or exists(select 1 from vendor_pay_applications where org_id = ${input.orgId} and id = ${input.payApplicationId ?? null} and subcontract_id = ${input.subcontractId})) as app_ok,
             (${input.vendorBillDocumentId ?? null}::uuid is null or exists(select 1 from documents d join subcontracts s on s.id = ${input.subcontractId} and s.org_id = d.org_id where d.org_id = ${input.orgId} and d.id = ${input.vendorBillDocumentId ?? null} and d.kind = 'vendor_bill' and d.party_id = s.vendor_id and d.project_id = s.project_id)) as bill_ok
    `));
    const row = scope.rows[0]!;
    if (!row.subcontract_ok) throw new SubcontractError("Subcontract not found");
    if (!row.payee_ok) throw new SubcontractError("Joint payee not found in this organization");
    if (!row.app_ok) throw new SubcontractError("Vendor application does not belong to this subcontract");
    if (!row.bill_ok) throw new SubcontractError("Vendor bill does not belong to this subcontract");
    const result = (await tx.execute<{ id: string }>(sql`
      insert into subcontract_payment_controls (org_id, subcontract_id, pay_application_id, vendor_bill_document_id,
        control_type, joint_payee_party_id, amount_limit, reason, effective_on, expires_on, created_by, updated_by)
      values (${input.orgId}, ${input.subcontractId}, ${input.payApplicationId ?? null}, ${input.vendorBillDocumentId ?? null},
        ${input.controlType}, ${input.jointPayeePartyId ?? null}, ${amountLimit}, ${reason}, ${input.effectiveOn}, ${input.expiresOn ?? null},
        ${input.userId}, ${input.userId}) returning id
    `));
    const id = result.rows[0]!.id;
    await audit(tx, input.orgId, "subcontract_payment_controls", id, "insert", { after: input }, input.userId);
    return { id };
  });
}

export async function releaseSubcontractPaymentControl(
  orgId: string,
  userId: string,
  id: string,
  releaseReason: string,
): Promise<void> {
  const reason = releaseReason.trim();
  if (!reason) throw new SubcontractError("Release reason is required");
  await db.transaction(async (tx) => {
    await assertFeatureEnabled(tx, orgId);
    const result = (await tx.execute(sql`
      update subcontract_payment_controls set status = 'released', released_at = now(), released_by = ${userId},
        release_reason = ${reason}, updated_at = now(), updated_by = ${userId}
      where org_id = ${orgId} and id = ${id} and status = 'active' returning id
    `));
    if (!result.rows.length) throw new SubcontractError("Active payment control not found");
    await audit(tx, orgId, "subcontract_payment_controls", id, "release", { after: { status: "released", releaseReason: reason } }, userId);
  });
}

/**
 * Payment workflow integration point. A null control limit blocks every
 * ordinary payment; a populated limit is the maximum ordinary one-payee
 * payment that may pass without releasing the hold or using a joint check.
 */
export async function assertSubcontractPaymentCleared(
  orgId: string,
  vendorBillDocumentId: string,
  paymentAmount?: string | null,
): Promise<void> {
  const today = await businessToday(orgId);
  const result = (await db.execute<{ control_type: string; reason: string; amount_limit: string | null; joint_payee: string | null }>(sql`
    select pc.control_type, pc.reason, pc.amount_limit::text, p.display_name as joint_payee
      from subcontract_payment_controls pc
      left join parties p on p.id = pc.joint_payee_party_id and p.org_id = pc.org_id
     where pc.org_id = ${orgId} and pc.status = 'active'
       and (pc.vendor_bill_document_id = ${vendorBillDocumentId}
         or exists(select 1 from vendor_pay_applications vpa where vpa.org_id = pc.org_id and vpa.id = pc.pay_application_id and vpa.vendor_bill_document_id = ${vendorBillDocumentId})
         or exists(select 1 from vendor_pay_applications vpa where vpa.org_id = pc.org_id and vpa.vendor_bill_document_id = ${vendorBillDocumentId} and vpa.subcontract_id = pc.subcontract_id and pc.pay_application_id is null and pc.vendor_bill_document_id is null))
       and pc.effective_on <= ${today} and (pc.expires_on is null or pc.expires_on >= ${today})
       and (${paymentAmount ?? null}::numeric is null or pc.amount_limit is null or ${paymentAmount ?? null}::numeric > pc.amount_limit)
     order by pc.amount_limit nulls first, pc.created_at
  `));
  const control = result.rows[0];
  if (!control) return;
  const threshold = control.amount_limit ? ` above ${control.amount_limit}` : "";
  if (control.control_type === "joint_check") {
    throw new SubcontractError(`Payment${threshold} requires a joint check with ${control.joint_payee ?? "the recorded joint payee"}`);
  }
  throw new SubcontractError(`Payment${threshold} is on hold: ${control.reason}`);
}
