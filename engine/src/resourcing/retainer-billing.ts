import { and, eq, sql } from "drizzle-orm";
import { resRetainerDrawdowns, resRetainers } from "@openbooks/schema";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { add, cmp, mulDecimal, roundMoney, sum } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { recordRecognitionEvent } from "../revenue/recognition-events.ts";
import { ResourcingRefusal } from "./errors.ts";
import {
  assertDrawdownWithinBalance,
  assertWriteRows,
  loadRetainerForScope,
  loadRetainerForUpdate,
  requireActiveRetainer,
  retainerBalance,
  withRetainerWrite,
  writeAudit,
  type RetainerRow,
  type RetainerWriteInput,
} from "./retainers.ts";

type InvoiceSetupRow = {
  projectCustomerId: string | null;
  subsidiaryId: string | null;
  projectStatus: string;
  itemName: string;
  incomeAccountId: string | null;
  itemDeferredAccountId: string | null;
  recognitionRuleId: string | null;
};
type RecognitionRuleRow = { deferredAccountId: string | null; method: string; isForecast: boolean };
type LinkedDocumentRow = { id: string; status: string };
type InvoiceWriteRow = { id: string };
type ActivationRow = {
  id: string;
  allocated_price: string;
  deferred_account_id: string | null;
};
type DrawdownAuditRow = { changes: { after?: Record<string, unknown> } | null };
export type RetainerBillingInput = RetainerWriteInput;

/** Create the ordinary one-line invoice that will establish this retainer's obligation. */
export async function generateRetainerInvoice(input: RetainerBillingInput): Promise<{ invoiceId: string }> {
  return withRetainerWrite(input.orgId, async (tx) => {
    const retainer = await loadRetainerForUpdate(input);
    if (retainer.state !== "draft") {
      throw new ResourcingRefusal(409, "retainer_not_invoiceable", `a ${retainer.state} retainer cannot be invoiced`, "choose a draft retainer", "retainerId");
    }
    if (!(await lockAndCheckOrgFeature(tx, input.orgId, "revenueRecognition"))) {
      throw new ResourcingRefusal(409, "revenue_recognition_disabled", "revenue recognition is disabled for this organization", "enable Revenue Recognition in Company Settings → Features", "retainerId");
    }

    if (retainer.invoiceDocumentId !== null) {
      const linked = (await tx.execute<LinkedDocumentRow>(sql`
        select id, status from documents
         where org_id = ${input.orgId} and id = ${retainer.invoiceDocumentId}
         for update
      `)).rows[0];
      if (!linked) throw new Error("retainer invoice link points to a missing document");
      if (linked.status !== "voided") {
        throw new ResourcingRefusal(409, "retainer_invoice_already_linked", "this retainer already has a live invoice", "delete or void the linked invoice before generating another", "retainerId");
      }
      const cleared = await tx.update(resRetainers).set({
        invoiceDocumentId: null,
        updatedAt: new Date(),
        updatedBy: input.actorId,
      }).where(and(
        eq(resRetainers.orgId, input.orgId),
        eq(resRetainers.id, retainer.id),
        eq(resRetainers.state, "draft"),
        eq(resRetainers.invoiceDocumentId, linked.id),
      )).returning({ id: resRetainers.id });
      assertWriteRows(cleared, 1, "voided retainer invoice unlink");
      await writeAudit(input.orgId, "res_retainers", retainer.id, "update", {
        before: { invoiceDocumentId: linked.id }, after: { invoiceDocumentId: null },
        reason: "linked invoice was voided",
      }, input.actorId);
    }

    const setup = (await tx.execute<InvoiceSetupRow>(sql`
      select p.customer_id as "projectCustomerId", p.subsidiary_id as "subsidiaryId",
             p.status as "projectStatus", i.name as "itemName", i.income_account_id as "incomeAccountId",
             i.deferred_account_id as "itemDeferredAccountId",
             i.recognition_rule_id as "recognitionRuleId"
        from projects p
        join items i on i.org_id = p.org_id and i.id = ${retainer.retainerItemId}
       where p.org_id = ${input.orgId} and p.id = ${retainer.projectId}
       for share of p, i
    `)).rows[0];
    if (!setup) throw new Error("retainer invoice source project or item disappeared");
    if (setup.projectStatus === "closed" || setup.projectStatus === "cancelled") {
      throw new ResourcingRefusal(409, "project_not_open", `cannot invoice a retainer for a ${setup.projectStatus} project`, "reopen the project or choose an active one", "projectId");
    }
    if (setup.projectCustomerId !== retainer.customerPartyId) {
      throw new ResourcingRefusal(409, "retainer_customer_mismatch", "retainer customer no longer matches the project's customer", "correct the project customer before invoicing the retainer", "customerPartyId");
    }
    const rule = setup.recognitionRuleId
      ? (await tx.execute<RecognitionRuleRow>(sql`
          select deferred_account_id as "deferredAccountId", method, is_forecast as "isForecast"
            from recognition_rules where org_id = ${input.orgId} and id = ${setup.recognitionRuleId}
           for share
        `)).rows[0] ?? null
      : null;
    if (!setup.itemDeferredAccountId && !rule?.deferredAccountId) {
      throw new ResourcingRefusal(422, "retainer_deferred_account_required", "the retainer item and recognition rule have no deferred revenue account", "map a deferred revenue account on the item or its recognition rule", "retainerItemId");
    }
    const requiredMethod = retainer.kind === "hours" ? "usage" : "milestone";
    if (rule?.method !== requiredMethod) {
      throw new ResourcingRefusal(422, "retainer_recognition_method_mismatch", `the retainer recognition rule must use ${requiredMethod}`, `select a ${requiredMethod} recognition rule for this retainer item`, "retainerItemId");
    }
    if (rule.isForecast) {
      throw new ResourcingRefusal(422, "retainer_forecast_rule", "a forecast recognition rule cannot back a billed retainer", "select an active non-forecast recognition rule for this retainer item", "retainerItemId");
    }

    const amount = retainer.kind === "hours"
      ? roundMoney(mulDecimal(roundMoney(retainer.totalHours!, 4), roundMoney(retainer.unitRate!, 4)), 2)
      : roundMoney(retainer.totalAmount, 2);
    if (cmp(amount, retainer.totalAmount) !== 0) throw new Error("retainer invoice amount differs from stored terms");
    const documentNumber = await allocateDocumentNumber(tx, input.orgId, "customer_invoice", "INV-");
    const invoice = await tx.execute<InvoiceWriteRow>(sql`
      insert into documents
        (org_id, kind, document_number, party_id, subsidiary_id, document_date,
         currency, status, project_id, memo, subtotal, tax_total, total, created_by)
      values (${input.orgId}, 'customer_invoice', ${documentNumber}, ${retainer.customerPartyId},
              ${setup.subsidiaryId}, ${retainer.startsOn}, ${retainer.currency},
              'draft', ${retainer.projectId}, ${`Retainer ${documentNumber}`}, ${amount}, '0', ${amount}, ${input.actorId})
      returning id
    `);
    assertWriteRows(invoice.rows, 1, "retainer invoice creation");
    const invoiceId = invoice.rows[0]!.id;
    const quantity = retainer.kind === "hours" ? retainer.totalHours! : "1";
    const unitPrice = retainer.kind === "hours" ? retainer.unitRate! : amount;
    const line = await tx.execute<InvoiceWriteRow>(sql`
      insert into document_lines
        (org_id, document_id, line_number, item_id, account_id, description, quantity, unit_price,
         amount, project_id, custom, is_billable, created_by)
      values (${input.orgId}, ${invoiceId}, 1, ${retainer.retainerItemId}, ${setup.incomeAccountId},
              ${setup.itemName}, ${quantity}, ${unitPrice}, ${amount}, ${retainer.projectId},
              ${JSON.stringify({ recognitionStartsOn: retainer.startsOn, recognitionEndsOn: retainer.endsOn })}::jsonb,
              true, ${input.actorId})
      returning id
    `);
    assertWriteRows(line.rows, 1, "retainer invoice line creation");
    const linked = await tx.update(resRetainers).set({
      invoiceDocumentId: invoiceId,
      updatedAt: new Date(),
      updatedBy: input.actorId,
    }).where(and(
      eq(resRetainers.orgId, input.orgId),
      eq(resRetainers.id, retainer.id),
      eq(resRetainers.state, "draft"),
    )).returning({ id: resRetainers.id });
    assertWriteRows(linked, 1, "retainer invoice link");
    await writeAudit(input.orgId, "res_retainers", retainer.id, "update", {
      before: { invoiceDocumentId: retainer.invoiceDocumentId },
      after: { invoiceDocumentId: invoiceId, documentNumber, amount, currency: retainer.currency },
    }, input.actorId);
    return { invoiceId };
  });
}

/** Complete the only activation transition after a linked invoice is posted. */
export async function syncRetainerActivation(
  tx: SqlExecutor,
  orgId: string,
  retainerId: string,
  actorId?: string | null,
): Promise<RetainerRow | null> {
  const retainer = (await tx.execute<RetainerRow>(sql`
    select id, org_id as "orgId", project_id as "projectId", customer_party_id as "customerPartyId",
           kind, total_amount::text as "totalAmount", currency, total_hours::text as "totalHours",
           unit_rate::text as "unitRate", starts_on::text as "startsOn", ends_on::text as "endsOn",
           retainer_item_id as "retainerItemId", invoice_document_id as "invoiceDocumentId",
           obligation_id as "obligationId", state, custom, created_at as "createdAt", created_by as "createdBy",
           updated_at as "updatedAt", updated_by as "updatedBy"
      from res_retainers where org_id = ${orgId} and id = ${retainerId} for update
  `)).rows[0];
  if (!retainer) return null;
  if (retainer.state !== "draft" || retainer.invoiceDocumentId === null) return retainer;
  const invoice = (await tx.execute<{ status: string }>(sql`
    select status from documents where org_id = ${orgId} and id = ${retainer.invoiceDocumentId}
  `)).rows[0];
  if (!invoice || invoice.status !== "posted") return retainer;

  const obligations = await tx.execute<ActivationRow>(sql`
    select po.id, po.allocated_price::text as allocated_price, po.deferred_account_id
      from performance_obligations po
      join document_lines dl on dl.org_id = po.org_id and dl.id = po.document_line_id
     where po.org_id = ${orgId} and dl.document_id = ${retainer.invoiceDocumentId}
       and dl.item_id = ${retainer.retainerItemId}
     order by dl.line_number
  `);
  const revRecCount = (await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
      from performance_obligations po
      join document_lines dl on dl.org_id = po.org_id and dl.id = po.document_line_id
     where po.org_id = ${orgId} and dl.document_id = ${retainer.invoiceDocumentId}
  `)).rows[0]?.count ?? 0;
  const obligation = obligations.rows[0];
  if (!obligation) {
    throw new ResourcingRefusal(409, "retainer_obligation_missing", "the posted retainer invoice has no recognition obligation", "void the invoice, enable Revenue Recognition, and generate a replacement retainer invoice", "invoiceDocumentId");
  }
  if (obligations.rows.length !== 1 || revRecCount !== 1 || cmp(obligation.allocated_price, retainer.totalAmount) !== 0) {
    throw new ResourcingRefusal(409, "retainer_obligation_allocation_mismatch", "the retainer invoice must contain one recognition obligation allocated at the retainer total", "void the invoice, remove additional revenue-recognition lines, and generate a replacement retainer invoice", "invoiceDocumentId");
  }
  if (obligation.deferred_account_id === null) {
    throw new ResourcingRefusal(409, "retainer_obligation_deferred_account_missing", "the retainer invoice obligation has no deferred revenue account", "map a deferred revenue account on the item or its recognition rule, then void and replace the invoice", "invoiceDocumentId");
  }
  const updated = await tx.execute<{ id: string }>(sql`
    update res_retainers
       set obligation_id = ${obligation.id}, state = 'active', updated_at = now(), updated_by = ${actorId ?? retainer.updatedBy}
     where org_id = ${orgId} and id = ${retainerId} and state = 'draft'
       and invoice_document_id = ${retainer.invoiceDocumentId} and obligation_id is null
     returning id
  `);
  assertWriteRows(updated.rows, 1, "retainer activation");
  await writeAudit(orgId, "res_retainers", retainerId, "update", {
    before: { state: "draft", obligationId: null },
    after: { state: "active", obligationId: obligation.id, invoiceDocumentId: retainer.invoiceDocumentId },
  }, actorId ?? retainer.updatedBy ?? retainer.createdBy ?? null, tx);
  return { ...retainer, state: "active", obligationId: obligation.id };
}

/** Record the drawdown's stable month split before committing its posted state. */
export async function postDrawdown(
  input: RetainerBillingInput & { drawdownId: string },
): Promise<{ id: string; state: "posted"; balance: string; retainerState: RetainerRow["state"] }> {
  return withRetainerWrite(input.orgId, async (tx) => {
    await loadRetainerForScope(input);
    await syncRetainerActivation(tx, input.orgId, input.retainerId, input.actorId);
    const retainer = await loadRetainerForUpdate(input);
    const drawdown = (await tx.select({
      id: resRetainerDrawdowns.id,
      weekStart: resRetainerDrawdowns.weekStart,
      hours: resRetainerDrawdowns.hours,
      amount: resRetainerDrawdowns.amount,
      state: resRetainerDrawdowns.state,
    }).from(resRetainerDrawdowns).where(and(
      eq(resRetainerDrawdowns.orgId, input.orgId),
      eq(resRetainerDrawdowns.retainerId, input.retainerId),
      eq(resRetainerDrawdowns.id, input.drawdownId),
    )).limit(1).for("update"))[0];
    if (!drawdown) throw new Error("retainer drawdown not found in organization");
    if (drawdown.state === "posted") {
      const balance = await retainerBalance(input.orgId, retainer);
      return { id: drawdown.id, state: "posted", balance: balance.amount, retainerState: retainer.state };
    }
    requireActiveRetainer(retainer);
    assertDrawdownWithinBalance(drawdown.amount, (await retainerBalance(input.orgId, retainer)).amount, retainer.kind);

    const eventAmounts: Record<string, string> = {};
    const eventHours: Record<string, string> = {};
    if (retainer.kind === "hours") {
      const audit = (await tx.execute<DrawdownAuditRow>(sql`
        select changes from audit_log
         where org_id = ${input.orgId} and table_name = 'res_retainer_drawdowns'
           and row_id = ${drawdown.id} and action = 'insert'
         order by created_at desc limit 1
      `)).rows[0]?.changes?.after;
      const amounts = audit?.byMonth;
      const hours = audit?.hoursByMonth;
      if (!isStringMap(amounts) || !isStringMap(hours)) throw new Error("hours drawdown has no immutable monthly price snapshot");
      if (cmp(sum(Object.values(amounts)), drawdown.amount) !== 0 || cmp(sum(Object.values(hours)), drawdown.hours) !== 0) {
        throw new Error("hours drawdown monthly snapshot does not reconcile to its stored totals");
      }
      Object.assign(eventAmounts, amounts);
      Object.assign(eventHours, hours);
    } else {
      const month = drawdown.weekStart.slice(0, 7);
      eventAmounts[month] = drawdown.amount;
    }

    if (!retainer.obligationId) throw new Error("active retainer has no recognition obligation");
    for (const month of Object.keys(eventAmounts).sort()) {
      const amount = eventAmounts[month]!;
      if (retainer.kind === "hours") {
        const quantity = eventHours[month]!;
        const unitRate = retainer.unitRate!;
        await recordRecognitionEvent({
          obligationId: retainer.obligationId,
          orgId: input.orgId,
          actorId: input.actorId,
          periodMonth: `${month}-01`,
          amount,
          sourceReference: `resourcing:retainer-drawdown:${drawdown.id}:${month}`,
          quantity,
          unitRate,
        });
      } else {
        await recordRecognitionEvent({
          obligationId: retainer.obligationId,
          orgId: input.orgId,
          actorId: input.actorId,
          periodMonth: `${month}-01`,
          amount,
          sourceReference: `resourcing:retainer-drawdown:${drawdown.id}:${month}`,
        });
      }
    }

    const posted = await tx.update(resRetainerDrawdowns).set({
      state: "posted",
      updatedAt: new Date(),
      updatedBy: input.actorId,
    }).where(and(
      eq(resRetainerDrawdowns.orgId, input.orgId),
      eq(resRetainerDrawdowns.retainerId, input.retainerId),
      eq(resRetainerDrawdowns.id, drawdown.id),
      eq(resRetainerDrawdowns.state, "draft"),
    )).returning({ id: resRetainerDrawdowns.id });
    assertWriteRows(posted, 1, "retainer drawdown posting");
    await writeAudit(input.orgId, "res_retainer_drawdowns", drawdown.id, "update", {
      before: { state: "draft" },
      after: { state: "posted", amount: drawdown.amount, byMonth: eventAmounts },
    }, input.actorId);

    const balance = await retainerBalance(input.orgId, retainer);
    let retainerState = retainer.state;
    if (cmp(balance.amount, "0") === 0) {
      const exhausted = await tx.update(resRetainers).set({
        state: "exhausted",
        updatedAt: new Date(),
        updatedBy: input.actorId,
      }).where(and(
        eq(resRetainers.orgId, input.orgId),
        eq(resRetainers.id, retainer.id),
        eq(resRetainers.state, "active"),
      )).returning({ id: resRetainers.id });
      assertWriteRows(exhausted, 1, "retainer exhaustion transition");
      await writeAudit(input.orgId, "res_retainers", retainer.id, "update", {
        before: { state: "active", balance: add(balance.amount, drawdown.amount) },
        after: { state: "exhausted", balance: balance.amount },
      }, input.actorId);
      retainerState = "exhausted";
    }
    return { id: drawdown.id, state: "posted", balance: balance.amount, retainerState };
  });
}

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}
