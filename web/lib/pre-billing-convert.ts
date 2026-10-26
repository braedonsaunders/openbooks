import "server-only";
import { workCompletedOn, workPeriodOf } from "@openbooks/engine/records/work-period";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { add, allocateLargestRemainder, cmp, sum } from "@openbooks/engine/money/money";
import { computeLineTaxes } from "@openbooks/engine/tax/tax";
import { loadTaxComponentConfig, persistLineTaxComponents } from "@openbooks/engine/tax/persist";
import { nextDocumentNumber } from "./bills.ts";
import { isFeatureEnabled } from "./features";
import { lockProjectForScope, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import {
  INVENTORY_ITEM_KINDS,
  PreBillingError,
  type PrebillHeaderRow,
  type PrebillSourceLineRow,
  type PrebillStatus,
  type SubsidiaryScope,
  appendEvent,
  assertPreBillingEnabled,
  assertPreBillingEnabledTx,
  audit,
  currentPolicyIsNte,
  loadProjectPolicy,
  remainingContractCapacity,
} from "./pre-billing-core";

/**
 * Convert an approved worksheet into the existing billing-request and document
 * model. Exact source rows are locked and stamped in the same transaction as
 * the draft customer invoice, making double billing impossible even if two
 * conversion requests race.
 */
export async function convertPrebill(
  orgId: string,
  actorId: string,
  id: string,
  scope: SubsidiaryScope = null,
) {
  await assertPreBillingEnabled(orgId);
  const existing = await db.execute<{
    status: PrebillStatus;
    invoice_id: string | null;
    invoice_number: string | null;
    subsidiary_id: string | null;
  }>(
    sql`
    select worksheet.status, worksheet.invoice_document_id as invoice_id, project.subsidiary_id,
           invoice.document_number as invoice_number
      from prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
     where worksheet.org_id = ${orgId} and worksheet.id = ${id}
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
  `,
    "objects",
  );
  const observed = existing[0];
  if (!observed) throw new PreBillingError("Prebill not found", 404);
  if (observed.status === "converted" && observed.invoice_id) {
    return { id: observed.invoice_id, documentNumber: observed.invoice_number!, idempotent: true };
  }
  if (observed.status === "customer_review") {
    throw new PreBillingError(
      "This prebill is with the customer for review — wait for their decision, or reopen it",
    );
  }
  if (observed.status !== "approved")
    throw new PreBillingError("Only an approved prebill can be converted");
  return db.transaction(async (tx) => {
    await assertPreBillingEnabledTx(tx, orgId);
    const header = await tx.execute<PrebillHeaderRow>(
      sql`
      select worksheet.*, project.customer_id,
             coalesce(nullif(btrim(worksheet.customer_po_number), ''), project.customer_po_number) as customer_po_number,
             project.subsidiary_id,
             project.name as project_name, type.billing_method,
             coalesce(subsidiary.base_currency, org.base_currency) as currency
        from prebills worksheet
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
        join orgs org on org.id = worksheet.org_id
        left join subsidiaries subsidiary on subsidiary.org_id = project.org_id and subsidiary.id = project.subsidiary_id
        left join project_types type on type.org_id = project.org_id and type.id = project.project_type_id
       where worksheet.org_id = ${orgId} and worksheet.id = ${id}
         ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
       for update of worksheet
    `,
      "objects",
    );
    const worksheet = header[0];
    if (!worksheet) throw new PreBillingError("Prebill not found", 404);
    // Conversion mints a customer invoice: pin the project and recheck scope
    // under the lock before any line or document write.
    try {
      await lockProjectForScope(tx, orgId, worksheet.project_id, scope);
    } catch (error) {
      if (error instanceof ScopeNotFoundError) throw new PreBillingError("Prebill not found", 404);
      throw error;
    }
    if (worksheet.status === "converted" && worksheet.invoice_document_id) {
      const invoice = await tx.execute<{ document_number: string }>(
        sql`
        select document_number from documents where org_id = ${orgId} and id = ${worksheet.invoice_document_id}
      `,
        "objects",
      );
      return {
        id: worksheet.invoice_document_id,
        documentNumber: invoice[0]!.document_number,
        idempotent: true,
      };
    }
    if (worksheet.status === "customer_review") {
      throw new PreBillingError(
        "This prebill is with the customer for review — wait for their decision, or reopen it",
      );
    }
    if (worksheet.status !== "approved")
      throw new PreBillingError("Only an approved prebill can be converted");
    if (!worksheet.customer_id) throw new PreBillingError("The project has no customer to invoice");
    if (
      (worksheet.custom?.policy as { customerReview?: string } | undefined)?.customerReview ===
        "required" &&
      worksheet.customer_decision !== "accepted"
    ) {
      throw new PreBillingError(
        "This project type requires customer acceptance before invoicing — send the prebill to the customer first",
      );
    }
    if (!worksheet.currency)
      throw new PreBillingError("The project subsidiary has no functional currency");
    const policySnapshot = worksheet.custom?.policy as
      | {
          billingProcedure?: string;
          lineBuilder?: string;
          billingBasis?: string;
          totalPriceMethod?: string;
        }
      | undefined;
    if (
      !policySnapshot ||
      policySnapshot.billingProcedure !== "standard" ||
      !["tm_actual", "cost_plus"].includes(policySnapshot.lineBuilder ?? "")
    ) {
      throw new PreBillingError(
        "This worksheet does not contain an eligible source-line billing policy snapshot",
      );
    }
    if (
      policySnapshot.totalPriceMethod === "not_to_exceed" ||
      (await currentPolicyIsNte(tx, orgId, worksheet.project_id, worksheet.period_end))
    ) {
      // Conversion mints the invoice: lock the project and recheck scope in
      // the same transaction so a concurrent rehome cannot bill B's project.
      const policy = await loadProjectPolicy(tx, orgId, worksheet.project_id, true, scope);
      const capacity = await remainingContractCapacity(tx, orgId, policy, worksheet.period_end, id);
      if (cmp(String(worksheet.proposed_bill_amount), capacity ?? "0") > 0) {
        throw new PreBillingError(
          `Prebill exceeds the remaining not-to-exceed capacity of ${capacity ?? "0.0000"}`,
        );
      }
    }

    const lines = await tx.execute<PrebillSourceLineRow>(
      sql`
      select line.*,
             exists (
               select 1 from prebill_holds hold
                where hold.org_id = line.org_id and hold.source_type = line.source_type
                  and hold.source_id = coalesce(line.time_entry_id, line.document_line_id)
                  and hold.released_at is null
             ) as actively_held
        from prebill_lines line
       where line.org_id = ${orgId} and line.prebill_id = ${id} and line.disposition = 'bill'
       order by line.line_number
       for update
    `,
      "objects",
    );
    if (lines.length === 0) throw new PreBillingError("The prebill has no billable lines");
    if (lines.some((line) => line.actively_held))
      throw new PreBillingError("Release all billing holds before conversion");
    // Stored prebill lines and existing invoices stay. Turning Inventory off
    // must refuse a convert that would persist inventory / assembly / kit.
    if (!(await isFeatureEnabled(orgId, "inventory"))) {
      const itemIds = [
        ...new Set(
          lines
            .map((line) => line.item_id as string | null)
            .filter((itemId): itemId is string => Boolean(itemId)),
        ),
      ];
      for (const itemId of itemIds) {
        const item = await tx.execute<{ kind: string }>(
          sql`
          select kind from items where id = ${itemId} and org_id = ${orgId}`,
          "objects",
        );
        if (item[0] && INVENTORY_ITEM_KINDS.has(item[0].kind)) {
          throw new PreBillingError("Inventory is disabled", 404);
        }
      }
    }
    // Stored prebill lines and existing invoices stay. Turning Equipment off
    // must refuse a convert that would persist equipment_charge.
    if (!(await isFeatureEnabled(orgId, "equipment"))) {
      const itemIds = [
        ...new Set(
          lines
            .map((line) => line.item_id as string | null)
            .filter((itemId): itemId is string => Boolean(itemId)),
        ),
      ];
      for (const itemId of itemIds) {
        const item = await tx.execute<{ kind: string }>(
          sql`
          select kind from items where id = ${itemId} and org_id = ${orgId}`,
          "objects",
        );
        if (item[0] && item[0].kind === "equipment_charge") {
          throw new PreBillingError("Equipment is disabled", 404);
        }
      }
    }

    // Approval freezes each source line's account. Never substitute another
    // chart account or re-read the item's current policy during conversion.
    // Validate before reserving a number, and retain the account locks until
    // conversion commits so deactivation cannot race the generated invoice.
    for (const line of lines) {
      if (!line.income_account_id) {
        throw new PreBillingError(
          `Prebill line ${line.line_number} has no configured income account. Correct the source accounting configuration, void this prebill, and create a new prebill for approval.`,
        );
      }
      const account = await tx.execute<{ id: string }>(
        sql`
        select id from accounts
         where org_id = ${orgId} and id = ${line.income_account_id}
           and is_active and not is_summary
         for share
      `,
        "objects",
      );
      if (!account[0]) {
        throw new PreBillingError(
          `Prebill line ${line.line_number} requires an active, non-summary account in this organization. Correct the source accounting configuration, void this prebill, and create a new prebill for approval.`,
        );
      }
    }

    const invoiceNumber = await nextDocumentNumber(
      orgId,
      "customer_invoice",
      "INV-",
      worksheet.subsidiary_id,
    );

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`billing-request-number:${orgId}`}, 0))`,
    );
    const requestNumberResult = await tx.execute<{ n: string }>(
      sql`
      select coalesce(max((regexp_replace(request_number, '\\D', '', 'g'))::bigint), 0) as n
        from billing_requests where org_id = ${orgId} and request_number ~ '^BREQ-[0-9]+$'
    `,
      "objects",
    );
    const requestNumber = `BREQ-${String(Number(requestNumberResult[0]?.n ?? 0) + 1).padStart(5, "0")}`;
    const timeIds = lines.filter((line) => line.time_entry_id).map((line) => line.time_entry_id);
    const sourceCostLineIds = lines
      .filter((line) => line.document_line_id)
      .map((line) => line.document_line_id);
    const requestResult = await tx.execute<{ id: string }>(
      sql`
      insert into billing_requests (
        org_id, project_id, request_number, invoice_type, basis, cutoff_date,
        invoice_description, customer_po, billing_method_snapshot, selected_time_entry_ids,
        notes, status, custom, created_by, updated_by
      ) values (
        ${orgId}, ${worksheet.project_id}, ${requestNumber}, 'progress', ${policySnapshot.billingBasis ?? "date_range"},
        ${worksheet.period_end}, ${`Prebill ${worksheet.worksheet_number}`}, ${worksheet.customer_po_number},
        ${worksheet.billing_method ?? "time_and_materials"}, ${JSON.stringify(timeIds)}::jsonb,
        ${worksheet.notes}, 'open',
        ${JSON.stringify({ prebillId: id, selectedCostLineIds: sourceCostLineIds, policy: policySnapshot })}::jsonb,
        ${actorId}, ${actorId}
      ) returning id
    `,
      "objects",
    );
    const billingRequestId = requestResult[0]!.id;

    const invoiceResult = await tx.execute<{ id: string }>(
      sql`
      insert into documents (
        org_id, kind, document_number, party_id, document_date, currency, status,
        project_id, subsidiary_id, billing_method, is_final_invoice, reference_number,
        memo, subtotal, tax_total, total, custom, work_completed_on, created_by, updated_by
      ) values (
        ${orgId}, 'customer_invoice', ${invoiceNumber}, ${worksheet.customer_id}, ${worksheet.period_end},
        ${worksheet.currency}, 'draft', ${worksheet.project_id}, ${worksheet.subsidiary_id},
        ${worksheet.billing_method === "fixed_price" ? "fixed_price" : "time_and_materials"}, false,
        ${worksheet.customer_po_number}, ${`Created from ${worksheet.worksheet_number}`},
        '0', '0', '0', ${JSON.stringify({ prebillId: id, billingRequestId, policy: policySnapshot })}::jsonb,
        ${workCompletedOn(lines.map((line) => workPeriodOf([line.source_date])))},
        ${actorId}, ${actorId}
      ) returning id
    `,
      "objects",
    );
    const invoiceId = invoiceResult[0]!.id;
    const billedAmounts: string[] = [];
    const billedTaxes: string[] = [];

    // Approved lines price at four decimals but the invoice settles whole
    // minor units. Rounding each line independently can certify a total
    // nobody approved (two 0.0050 draws round to 0.02 against an approved
    // 0.01), so the rounded approved total is allocated across the lines by
    // largest remainder: the invoice lines sum to the approved total exactly.
    const settledAmounts = allocateLargestRemainder(
      lines.map((line) => String(line.proposed_bill_amount)),
      2,
    );
    for (const [index, line] of lines.entries()) {
      const inputAmount = settledAmounts[index]!;
      const taxConfig = line.tax_code_id
        ? await loadTaxComponentConfig(orgId, line.tax_code_id, worksheet.period_end, tx)
        : [];
      if (line.tax_code_id && taxConfig.length === 0) {
        throw new PreBillingError(
          `Tax code on line ${line.line_number} is inactive or has no effective rate`,
        );
      }
      const calculated = computeLineTaxes(inputAmount, taxConfig);
      const amount = calculated.netAmount;
      const taxAmount = calculated.taxTotal;
      const accountId = line.income_account_id;
      const invoiceLineResult = await tx.execute<{ id: string }>(
        sql`
        insert into document_lines (
          org_id, document_id, line_number, item_id, account_id, description,
          quantity, unit, unit_price, amount, tax_code_id, tax_amount, department_id, project_id,
          employee_id, time_entry_id, time_type_id, is_billable, bill_rate, bill_amount,
          work_from, work_to, custom, created_by, updated_by
        ) values (
          ${orgId}, ${invoiceId}, ${index + 1}, ${line.item_id}, ${accountId}, ${line.description},
          ${line.quantity}, ${line.unit},
          case when ${line.quantity}::numeric = 0 then ${amount}::numeric else ${amount}::numeric / ${line.quantity}::numeric end,
          ${amount}, ${line.tax_code_id}, ${taxAmount}, ${line.department_id}, ${worksheet.project_id},
          ${line.employee_party_id}, ${line.time_entry_id}, ${line.time_type_id}, true,
          case when ${line.quantity}::numeric = 0 then ${amount}::numeric else ${amount}::numeric / ${line.quantity}::numeric end,
          ${amount}, ${line.source_date}, ${line.source_date},
          ${JSON.stringify({ prebillLineId: line.id, originalBillAmount: line.original_bill_amount, adjustmentAmount: line.adjustment_amount })}::jsonb,
          ${actorId}, ${actorId}
        ) returning id
      `,
        "objects",
      );
      const invoiceLineId = invoiceLineResult[0]!.id;
      await persistLineTaxComponents(orgId, invoiceLineId, calculated.components, actorId, tx);
      if (line.source_type === "time_entry") {
        const stamped = await tx.execute<{ id: string }>(
          sql`
          update time_entries set invoiced_by_line_id = ${invoiceLineId}, billing_status = 'billed', updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${line.time_entry_id}
             and status = 'approved' and is_billable and billing_status = 'unbilled'
           returning id
        `,
          "objects",
        );
        if (!stamped[0])
          throw new PreBillingError(
            `Time source on line ${line.line_number} is no longer available`,
          );
      } else {
        const stamped = await tx.execute<{ id: string }>(
          sql`
          update document_lines set billed_by_line_id = ${invoiceLineId}, updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${line.document_line_id} and billed_by_line_id is null
           returning id
        `,
          "objects",
        );
        if (!stamped[0])
          throw new PreBillingError(
            `Cost source on line ${line.line_number} is no longer available`,
          );
      }
      billedAmounts.push(amount);
      billedTaxes.push(taxAmount);
    }

    const subtotal = sum(billedAmounts);
    const taxTotal = sum(billedTaxes);
    const total = add(subtotal, taxTotal);
    await tx.execute(sql`
      update documents set subtotal = ${subtotal}, tax_total = ${taxTotal}, total = ${total}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${invoiceId}
    `);
    await tx.execute(sql`
      update billing_requests set status = 'invoiced', invoice_document_id = ${invoiceId}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${billingRequestId}
    `);
    await tx.execute(sql`
      update prebills
         set status = 'converted', billing_request_id = ${billingRequestId}, invoice_document_id = ${invoiceId},
             converted_at = now(), converted_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
    `);
    await appendEvent(tx, orgId, id, actorId, "converted", {
      billingRequestId,
      invoiceId,
      invoiceNumber,
      subtotal,
    });
    await audit(tx, orgId, "prebills", id, actorId, {
      before: { status: "approved" },
      after: { status: "converted", billingRequestId, invoiceDocumentId: invoiceId },
    });
    return { id: invoiceId, documentNumber: invoiceNumber, billingRequestId, idempotent: false };
  });
}
