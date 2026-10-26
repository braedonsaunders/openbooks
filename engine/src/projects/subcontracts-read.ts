import { sql, type SQL } from "drizzle-orm";
import { lockProjectForScope, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";

type ScopeTable =
  | "projects"
  | "subcontracts"
  | "subcontract_sov_lines"
  | "subcontract_change_orders"
  | "vendor_pay_applications"
  | "subcontract_payment_controls";

const ACTION_SCOPE: Record<string, { table: ScopeTable; key: string }> = {
  createSubcontract: { table: "projects", key: "projectId" },
  updateSubcontract: { table: "subcontracts", key: "id" },
  submitSubcontract: { table: "subcontracts", key: "id" },
  approveSubcontract: { table: "subcontracts", key: "id" },
  transitionSubcontract: { table: "subcontracts", key: "id" },
  addSovLine: { table: "subcontracts", key: "subcontractId" },
  removeSovLine: { table: "subcontract_sov_lines", key: "id" },
  addChangeOrder: { table: "subcontracts", key: "subcontractId" },
  approveChangeOrder: { table: "subcontract_change_orders", key: "id" },
  voidChangeOrder: { table: "subcontract_change_orders", key: "id" },
  createPayApplication: { table: "subcontracts", key: "subcontractId" },
  updatePayApplication: { table: "vendor_pay_applications", key: "payApplicationId" },
  submitPayApplication: { table: "vendor_pay_applications", key: "id" },
  approvePayApplication: { table: "vendor_pay_applications", key: "id" },
  voidPayApplication: { table: "vendor_pay_applications", key: "id" },
  createVendorBill: { table: "vendor_pay_applications", key: "id" },
  releaseRetainage: { table: "subcontracts", key: "subcontractId" },
  addPaymentControl: { table: "subcontracts", key: "subcontractId" },
  releasePaymentControl: { table: "subcontract_payment_controls", key: "id" },
};

export interface SubcontractActionProjectScope {
  found: boolean;
  subsidiaryId: string | null;
  projectId: string | null;
}

/** Resolve the project scope of an action before any mutation begins. */
export async function readSubcontractActionProjectScope(
  tx: SqlExecutor,
  orgId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<SubcontractActionProjectScope | undefined> {
  const source = ACTION_SCOPE[action];
  if (!source) return undefined;
  const id = body[source.key];
  if (typeof id !== "string" || !isUuid(id)) {
    return { found: false, subsidiaryId: null, projectId: null };
  }

  let query: SQL;
  if (source.table === "projects") {
    query = sql`select p.id as project_id, p.subsidiary_id from projects p where p.org_id = ${orgId} and p.id = ${id}`;
  } else if (source.table === "subcontracts") {
    query = sql`select p.id as project_id, p.subsidiary_id from subcontracts s
                  join projects p on p.id = s.project_id and p.org_id = s.org_id
                 where s.org_id = ${orgId} and s.id = ${id}`;
  } else {
    query = sql`select p.id as project_id, p.subsidiary_id from ${sql.raw(source.table)} child
                  join subcontracts s on s.id = child.subcontract_id and s.org_id = child.org_id
                  join projects p on p.id = s.project_id and p.org_id = s.org_id
                 where child.org_id = ${orgId} and child.id = ${id}`;
  }
  const row = (
    await tx.execute<{ project_id: string; subsidiary_id: string | null }>(query, "objects")
  )[0];
  return row
    ? { found: true, subsidiaryId: row.subsidiary_id, projectId: row.project_id }
    : { found: false, subsidiaryId: null, projectId: null };
}

export interface SubcontractDetail {
  subcontract: Record<string, unknown>;
  sovLines: Record<string, unknown>[];
  changeOrders: Record<string, unknown>[];
  payApplications: Record<string, unknown>[];
  payApplicationLines: Record<string, unknown>[];
  paymentControls: Record<string, unknown>[];
  retainageReleases: Record<string, unknown>[];
}

/** Load the scoped subcontract detail while its project ownership stays stable. */
export async function readSubcontractDetail(
  tx: SqlExecutor,
  input: {
    orgId: string;
    id: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<SubcontractDetail | null> {
  const contract = await tx.execute<
    Record<string, unknown> & { projectSubsidiaryId: string | null; projectId: string }
  >(
    sql`
    select s.id, s.number, s.title, s.description, s.status, s.currency, p.subsidiary_id as "projectSubsidiaryId",
           s.project_id as "projectId", p.name as "projectName", s.vendor_id as "vendorId", v.display_name as "vendorName",
           s.updated_at as "updatedAt",
           s.original_commitment as "originalCommitment", s.default_retainage_percent as "defaultRetainagePercent",
           s.purchase_order_id as "purchaseOrderId", s.starts_on as "startsOn", s.ends_on as "endsOn",
           s.payment_hold_reason as "paymentHoldReason", s.submitted_at as "submittedAt", s.approved_at as "approvedAt",
           (s.original_commitment + coalesce(ch.approved, 0))::text as "revisedCommitment"
      from subcontracts s join projects p on p.id = s.project_id and p.org_id = s.org_id
      join parties v on v.id = s.vendor_id and v.org_id = s.org_id
      left join lateral (select sum(amount) filter (where status = 'approved') as approved
        from subcontract_change_orders where org_id = s.org_id and subcontract_id = s.id) ch on true
     where s.org_id = ${input.orgId} and s.id = ${input.id}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
  `,
    "objects",
  );
  const row = contract[0];
  if (!row) return null;

  await lockProjectForScope(
    tx,
    input.orgId,
    String(row.projectId),
    input.allowedSubsidiaryIds,
    "share",
  );

  const sovLines = await tx.execute(
    sql`
      select l.id, l.item_no as "itemNo", l.description, l.scheduled_value as "scheduledValue",
             l.retainage_percent as "retainagePercent", l.expense_account_id as "expenseAccountId",
             l.change_order_id as "changeOrderId", l.sort_order as "sortOrder",
             coalesce(earned.earned, 0)::text as "earnedToDate"
        from subcontract_sov_lines l
        left join lateral (
          select vpal.previous_earned + vpal.work_completed_this_period + vpal.materials_stored_current - vpal.previous_materials_stored as earned
            from vendor_pay_application_lines vpal join vendor_pay_applications vpa on vpa.id = vpal.pay_application_id and vpa.org_id = vpal.org_id
           where vpal.org_id = l.org_id and vpal.sov_line_id = l.id and vpa.status = 'billed'
           order by vpa.application_number desc limit 1
        ) earned on true
       where l.org_id = ${input.orgId} and l.subcontract_id = ${input.id} order by l.sort_order, l.item_no
    `,
    "objects",
  );
  const changeOrders = await tx.execute(
    sql`
      select id, number, description, status, amount, target_sov_line_id as "targetSovLineId",
             approved_on as "approvedOn"
        from subcontract_change_orders where org_id = ${input.orgId} and subcontract_id = ${input.id} order by created_at desc
    `,
    "objects",
  );
  const payApplications = await tx.execute(
    sql`
      select a.id, a.application_number as "applicationNumber", a.period_end as "periodEnd",
             a.vendor_invoice_number as "vendorInvoiceNumber", a.status, a.revision,
             a.gross_this_period as "grossThisPeriod", a.retainage_this_period as "retainageThisPeriod", a.net_due as "netDue",
             a.vendor_bill_document_id as "vendorBillDocumentId", d.document_number as "vendorBillNumber", d.status as "vendorBillStatus"
        from vendor_pay_applications a left join documents d on d.id = a.vendor_bill_document_id and d.org_id = a.org_id
       where a.org_id = ${input.orgId} and a.subcontract_id = ${input.id} order by a.application_number desc
    `,
    "objects",
  );
  const payApplicationLines = await tx.execute(
    sql`
      select l.pay_application_id as "payApplicationId", l.sov_line_id as "sovLineId", sov.item_no as "itemNo", sov.description,
             sov.scheduled_value as "scheduledValue", l.previous_earned as "previousEarned",
             l.previous_materials_stored as "previousMaterialsStored", l.work_completed_this_period as "workCompletedThisPeriod",
             l.materials_stored_current as "materialsStoredCurrent", l.retainage_percent as "retainagePercent"
        from vendor_pay_application_lines l join vendor_pay_applications a on a.id = l.pay_application_id and a.org_id = l.org_id
        join subcontract_sov_lines sov on sov.id = l.sov_line_id and sov.org_id = l.org_id
       where l.org_id = ${input.orgId} and a.subcontract_id = ${input.id} order by a.application_number desc, sov.sort_order
    `,
    "objects",
  );
  const paymentControls = await tx.execute(
    sql`
      select c.id, c.control_type as "controlType", c.status, c.pay_application_id as "payApplicationId",
             c.vendor_bill_document_id as "vendorBillDocumentId", c.joint_payee_party_id as "jointPayeePartyId",
             p.display_name as "jointPayeeName", c.amount_limit as "amountLimit", c.reason,
             c.effective_on as "effectiveOn", c.expires_on as "expiresOn", c.release_reason as "releaseReason"
        from subcontract_payment_controls c left join parties p on p.id = c.joint_payee_party_id and p.org_id = c.org_id
       where c.org_id = ${input.orgId} and c.subcontract_id = ${input.id} order by c.created_at desc
    `,
    "objects",
  );
  const retainageReleases = await tx.execute(
    sql`
      select r.id, r.period_end as "periodEnd", r.amount, r.vendor_bill_document_id as "vendorBillDocumentId",
             d.document_number as "vendorBillNumber", d.status as "vendorBillStatus", r.memo
        from vendor_retainage_releases r join documents d on d.id = r.vendor_bill_document_id and d.org_id = r.org_id
       where r.org_id = ${input.orgId} and r.subcontract_id = ${input.id} order by r.period_end desc
    `,
    "objects",
  );

  const { projectSubsidiaryId, ...subcontract } = row;
  void projectSubsidiaryId;
  return {
    subcontract,
    sovLines,
    changeOrders,
    payApplications,
    payApplicationLines,
    paymentControls,
    retainageReleases,
  };
}
