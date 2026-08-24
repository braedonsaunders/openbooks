import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  SubcontractError,
  addSubcontractSovLine,
  approveSubcontract,
  approveSubcontractChangeOrder,
  approveVendorPayApplication,
  createSubcontract,
  createSubcontractChangeOrder,
  createSubcontractPaymentControl,
  createVendorPayApplication,
  generateVendorPayApplicationBill,
  releaseSubcontractPaymentControl,
  releaseVendorRetainage,
  removeSubcontractSovLine,
  submitSubcontract,
  submitVendorPayApplication,
  transitionSubcontract,
  updateDraftSubcontract,
  updateVendorPayApplicationLines,
  voidSubcontractChangeOrder,
  voidVendorPayApplication,
} from "@openbooks/engine/src/subcontracts.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { guardPermission, requirePermission } from "../../../lib/authz";
import { canonicalDecimal } from "../../../lib/exact-decimal";
import { isFeatureEnabled } from "../../../lib/features";
import { guardSubcontractsFeature } from "../../../lib/subcontracts-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Exact numeric(19,4) money string, or null when the request value is not canonical. */
function exactMoney(value: unknown): string | null {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) return null;
  try {
    return normalizeMoney(exact);
  } catch {
    return null;
  }
}

function invalidDecimal(label: string) {
  return NextResponse.json({ error: `${label} must be an exact decimal` }, { status: 422 });
}

export async function GET(request: Request) {
  const authz = await requirePermission("ap.read");
  const feature = await guardSubcontractsFeature(authz.user.orgId);
  if (feature) return feature;
  const orgId = authz.user.orgId;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    const rows = (await db.execute(sql`
      select s.id, s.number, s.title, s.status, s.currency,
             s.original_commitment as "originalCommitment",
             (s.original_commitment + coalesce(changes.approved, 0))::text as "revisedCommitment",
             coalesce(apps.billed, 0)::text as "billedToDate",
             coalesce(apps.retained, 0)::text as "retainageWithheld",
             p.name as "projectName", p.id as "projectId",
             v.display_name as "vendorName", v.id as "vendorId"
        from subcontracts s
        join projects p on p.id = s.project_id and p.org_id = s.org_id
        join parties v on v.id = s.vendor_id and v.org_id = s.org_id
        left join lateral (
          select sum(amount) filter (where status = 'approved') as approved
            from subcontract_change_orders where org_id = s.org_id and subcontract_id = s.id
        ) changes on true
        left join lateral (
          select sum(gross_this_period) filter (where status = 'billed') as billed,
                 sum(retainage_this_period) filter (where status = 'billed') as retained
            from vendor_pay_applications where org_id = s.org_id and subcontract_id = s.id
        ) apps on true
       where s.org_id = ${orgId}
       order by case s.status when 'active' then 0 when 'pending_approval' then 1 when 'draft' then 2 else 3 end,
                s.number
    `));
    return NextResponse.json({ subcontracts: rows.rows });
  }

  const contract = (await db.execute(sql`
    select s.id, s.number, s.title, s.description, s.status, s.currency,
           s.project_id as "projectId", p.name as "projectName", s.vendor_id as "vendorId", v.display_name as "vendorName",
           s.original_commitment as "originalCommitment", s.default_retainage_percent as "defaultRetainagePercent",
           s.purchase_order_id as "purchaseOrderId", s.starts_on as "startsOn", s.ends_on as "endsOn",
           s.payment_hold_reason as "paymentHoldReason", s.submitted_at as "submittedAt", s.approved_at as "approvedAt",
           (s.original_commitment + coalesce(ch.approved, 0))::text as "revisedCommitment"
      from subcontracts s join projects p on p.id = s.project_id and p.org_id = s.org_id
      join parties v on v.id = s.vendor_id and v.org_id = s.org_id
      left join lateral (select sum(amount) filter (where status = 'approved') as approved
        from subcontract_change_orders where org_id = s.org_id and subcontract_id = s.id) ch on true
     where s.org_id = ${orgId} and s.id = ${id}
  `));
  if (!contract.rows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [sov, changes, applications, lines, controls, releases] = (await Promise.all([
    db.execute(sql`
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
       where l.org_id = ${orgId} and l.subcontract_id = ${id} order by l.sort_order, l.item_no
    `),
    db.execute(sql`
      select id, number, description, status, amount, target_sov_line_id as "targetSovLineId",
             approved_on as "approvedOn", created_by <> ${authz.user.id} as "independentApprovalAllowed"
        from subcontract_change_orders where org_id = ${orgId} and subcontract_id = ${id} order by created_at desc
    `),
    db.execute(sql`
      select a.id, a.application_number as "applicationNumber", a.period_end as "periodEnd",
             a.vendor_invoice_number as "vendorInvoiceNumber", a.status,
             a.gross_this_period as "grossThisPeriod", a.retainage_this_period as "retainageThisPeriod", a.net_due as "netDue",
             a.vendor_bill_document_id as "vendorBillDocumentId", d.document_number as "vendorBillNumber", d.status as "vendorBillStatus",
             coalesce(a.submitted_by, a.created_by) <> ${authz.user.id} as "independentApprovalAllowed"
        from vendor_pay_applications a left join documents d on d.id = a.vendor_bill_document_id and d.org_id = a.org_id
       where a.org_id = ${orgId} and a.subcontract_id = ${id} order by a.application_number desc
    `),
    db.execute(sql`
      select l.pay_application_id as "payApplicationId", l.sov_line_id as "sovLineId", sov.item_no as "itemNo", sov.description,
             sov.scheduled_value as "scheduledValue", l.previous_earned as "previousEarned",
             l.previous_materials_stored as "previousMaterialsStored", l.work_completed_this_period as "workCompletedThisPeriod",
             l.materials_stored_current as "materialsStoredCurrent", l.retainage_percent as "retainagePercent"
        from vendor_pay_application_lines l join vendor_pay_applications a on a.id = l.pay_application_id and a.org_id = l.org_id
        join subcontract_sov_lines sov on sov.id = l.sov_line_id and sov.org_id = l.org_id
       where l.org_id = ${orgId} and a.subcontract_id = ${id} order by a.application_number desc, sov.sort_order
    `),
    db.execute(sql`
      select c.id, c.control_type as "controlType", c.status, c.pay_application_id as "payApplicationId",
             c.vendor_bill_document_id as "vendorBillDocumentId", c.joint_payee_party_id as "jointPayeePartyId",
             p.display_name as "jointPayeeName", c.amount_limit as "amountLimit", c.reason,
             c.effective_on as "effectiveOn", c.expires_on as "expiresOn", c.release_reason as "releaseReason"
        from subcontract_payment_controls c left join parties p on p.id = c.joint_payee_party_id and p.org_id = c.org_id
       where c.org_id = ${orgId} and c.subcontract_id = ${id} order by c.created_at desc
    `),
    db.execute(sql`
      select r.id, r.period_end as "periodEnd", r.amount, r.vendor_bill_document_id as "vendorBillDocumentId",
             d.document_number as "vendorBillNumber", d.status as "vendorBillStatus", r.memo
        from vendor_retainage_releases r join documents d on d.id = r.vendor_bill_document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.subcontract_id = ${id} order by r.period_end desc
    `),
  ]));
  return NextResponse.json({
    subcontract: contract.rows[0],
    sovLines: sov.rows,
    changeOrders: changes.rows,
    payApplications: applications.rows,
    payApplicationLines: lines.rows,
    paymentControls: controls.rows,
    retainageReleases: releases.rows,
  });
}

const approvalActions = new Set(["approveSubcontract", "approveChangeOrder", "approvePayApplication"]);
const postingActions = new Set(["createVendorBill", "releaseRetainage"]);
const paymentActions = new Set(["addPaymentControl", "releasePaymentControl"]);

export async function POST(request: Request) {
  const parsedBody = await parseJsonBody(request, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = ((parsedBody.data));
  const action = String(body.action ?? "");
  const permission = approvalActions.has(action) ? "ap.approve"
    : postingActions.has(action) ? "ap.post"
      : paymentActions.has(action) ? "ap.pay"
        : "ap.create";
  const authz = await guardPermission(permission);
  if (authz instanceof NextResponse) return authz;
  const feature = await guardSubcontractsFeature(authz.user.orgId);
  if (feature) return feature;
  const orgId = authz.user.orgId;
  const userId = authz.user.id;
  try {
    let result: unknown = { ok: true };
    switch (action) {
      case "createSubcontract": {
        // Transaction currency is Multi-currency configuration. Turning that
        // switch off must refuse a new write; omitting currency keeps the
        // vendor / subsidiary / org fallback so stored contracts stay valid.
        if (
          body.currency !== undefined &&
          !(await isFeatureEnabled(orgId, "multiCurrency"))
        ) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
        const originalCommitment = exactMoney(body.originalCommitment);
        if (originalCommitment === null) return invalidDecimal("Original commitment");
        const retainageInput = body.defaultRetainagePercent;
        const defaultRetainagePercent = retainageInput == null || retainageInput === ""
          ? undefined
          : exactMoney(retainageInput);
        if (defaultRetainagePercent === null) return invalidDecimal("Retainage percent");
        result = await createSubcontract({
          ...body, orgId, userId, originalCommitment, defaultRetainagePercent,
        } as unknown as { orgId: string; userId: string; projectId: string; vendorId: string; number: string; title: string; description?: string | null; currency?: string | null; originalCommitment: string; defaultRetainagePercent?: string; purchaseOrderId?: string | null; startsOn?: string | null; endsOn?: string | null; });
        break;
      }
      case "updateSubcontract": {
        const originalCommitment = exactMoney(body.originalCommitment);
        if (originalCommitment === null) return invalidDecimal("Original commitment");
        const defaultRetainagePercent = exactMoney(body.defaultRetainagePercent);
        if (defaultRetainagePercent === null) return invalidDecimal("Retainage percent");
        await updateDraftSubcontract({
          ...body, orgId, userId, originalCommitment, defaultRetainagePercent,
        } as unknown as { orgId: string; userId: string; id: string; title: string; description?: string | null; originalCommitment: string; defaultRetainagePercent: string; startsOn?: string | null; endsOn?: string | null; });
        break;
      }
      case "addSovLine": {
        const scheduledValue = exactMoney(body.scheduledValue);
        if (scheduledValue === null) return invalidDecimal("Scheduled value");
        let retainagePercent: string | null = null;
        if (body.retainagePercent != null && body.retainagePercent !== "") {
          retainagePercent = exactMoney(body.retainagePercent);
          if (retainagePercent === null) return invalidDecimal("Retainage percent");
        }
        result = await addSubcontractSovLine({
          ...body, orgId, userId, scheduledValue, retainagePercent,
        } as unknown as { orgId: string; userId: string; subcontractId: string; itemNo?: string | null; description: string; scheduledValue: string; retainagePercent?: string | null; expenseAccountId?: string | null; sortOrder?: number; });
        break;
      }
      case "removeSovLine":
        await removeSubcontractSovLine(orgId, userId, String(body.id));
        break;
      case "submitSubcontract":
        await submitSubcontract(orgId, userId, String(body.id));
        break;
      case "approveSubcontract":
        await approveSubcontract(orgId, userId, String(body.id));
        break;
      case "transitionSubcontract":
        await transitionSubcontract({ orgId, userId, id: String(body.id), action: body.transition });
        break;
      case "addChangeOrder": {
        const amount = exactMoney(body.amount);
        if (amount === null) return invalidDecimal("Amount");
        result = await createSubcontractChangeOrder({ ...body, orgId, userId, amount } as unknown as { orgId: string; userId: string; subcontractId: string; number: string; description?: string | null; amount: string; targetSovLineId?: string | null; });
        break;
      }
      case "approveChangeOrder":
        await approveSubcontractChangeOrder(orgId, userId, String(body.id), String(body.approvedOn));
        break;
      case "voidChangeOrder":
        await voidSubcontractChangeOrder(orgId, userId, String(body.id));
        break;
      case "createPayApplication":
        result = await createVendorPayApplication({ ...body, orgId, userId } as unknown as { orgId: string; userId: string; subcontractId: string; periodEnd: string; vendorInvoiceNumber?: string | null; });
        break;
      case "updatePayApplication": {
        if (!Array.isArray(body.lines)) {
          result = await updateVendorPayApplicationLines({ ...body, orgId, userId } as unknown as { orgId: string; userId: string; payApplicationId: string; lines: Array<{ sovLineId: string; workCompletedThisPeriod: string; materialsStoredCurrent: string; }>; });
          break;
        }
        const lines = [];
        for (const line of body.lines as Array<Record<string, unknown>>) {
          const workCompletedThisPeriod = exactMoney(line.workCompletedThisPeriod ?? "0");
          const materialsStoredCurrent = exactMoney(line.materialsStoredCurrent ?? "0");
          if (workCompletedThisPeriod === null || materialsStoredCurrent === null) {
            return invalidDecimal("Draw amount");
          }
          lines.push({
            sovLineId: String(line.sovLineId ?? ""),
            workCompletedThisPeriod,
            materialsStoredCurrent,
          });
        }
        result = await updateVendorPayApplicationLines({ ...body, orgId, userId, lines } as unknown as { orgId: string; userId: string; payApplicationId: string; lines: Array<{ sovLineId: string; workCompletedThisPeriod: string; materialsStoredCurrent: string; }>; });
        break;
      }
      case "submitPayApplication":
        result = await submitVendorPayApplication(orgId, userId, String(body.id));
        break;
      case "approvePayApplication":
        await approveVendorPayApplication(orgId, userId, String(body.id));
        break;
      case "voidPayApplication":
        await voidVendorPayApplication(orgId, userId, String(body.id));
        break;
      case "createVendorBill":
        result = await generateVendorPayApplicationBill(orgId, userId, String(body.id));
        break;
      case "releaseRetainage": {
        const amount = exactMoney(body.amount);
        if (amount === null) return invalidDecimal("Amount");
        result = await releaseVendorRetainage({ ...body, orgId, userId, amount } as unknown as { orgId: string; userId: string; subcontractId: string; periodEnd: string; amount: string; memo?: string | null; });
        break;
      }
      case "addPaymentControl": {
        let amountLimit: string | null = null;
        if (body.amountLimit != null && body.amountLimit !== "") {
          amountLimit = exactMoney(body.amountLimit);
          if (amountLimit === null) return invalidDecimal("Amount limit");
        }
        result = await createSubcontractPaymentControl({ ...body, orgId, userId, amountLimit } as unknown as { orgId: string; userId: string; subcontractId: string; payApplicationId?: string | null; vendorBillDocumentId?: string | null; controlType: "joint_check" | "payment_hold"; jointPayeePartyId?: string | null; amountLimit?: string | null; reason: string; effectiveOn: string; expiresOn?: string | null; });
        break;
      }
      case "releasePaymentControl":
        await releaseSubcontractPaymentControl(orgId, userId, String(body.id), String(body.releaseReason ?? ""));
        break;
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json(result, { status: action.startsWith("create") || action.startsWith("add") ? 201 : 200 });
  } catch (error) {
    if (error instanceof SubcontractError) return NextResponse.json({ error: error.message }, { status: 422 });
    const code = (error as { code?: string }).code;
    if (code === "23505") return NextResponse.json({ error: "That number is already in use" }, { status: 409 });
    console.error("[subcontracts] action failed", error);
    return NextResponse.json({ error: "Subcontract action failed" }, { status: 500 });
  }
}
