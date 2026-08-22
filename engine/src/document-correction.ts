import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrg } from "./db.ts";

export class DocumentCorrectionError extends Error {}

export interface DocumentCorrectionDraft {
  sourceDocumentId: string;
  replacementDocumentId: string;
  replacementDocumentNumber: string;
  created: boolean;
}

function correctionReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new DocumentCorrectionError(
      "a correction reason between 8 and 500 characters is required",
    );
  }
  return reason;
}

function correctionNumber(value: string): string {
  const number = value.trim();
  if (!number || number.length > 200) {
    throw new DocumentCorrectionError(
      "a replacement document number between 1 and 200 characters is required",
    );
  }
  return number;
}

/**
 * Create the retained draft for a posted-document correction.
 *
 * This deliberately does not mutate or silently cancel the source.  The
 * controller first reviews/edits this draft, then the ordinary controlled void
 * workflow reverses the source (including its approval gates and dependency
 * checks).  submitForApproval refuses to release the replacement until that
 * void has completed.  Posting the replacement therefore produces the exact
 * append-only sequence:
 *
 *   original entry -> exact reversal entry -> replacement entry
 *
 * The source row, source lines, source tax snapshots, and original journal
 * evidence remain intact throughout.
 */
export async function createDocumentCorrectionDraft(input: {
  orgId: string;
  sourceDocumentId: string;
  replacementDocumentNumber: string;
  actorId: string;
  reason: string;
}): Promise<DocumentCorrectionDraft> {
  const reason = correctionReason(input.reason);
  const replacementDocumentNumber = correctionNumber(
    input.replacementDocumentNumber,
  );
  if (!input.actorId) {
    throw new DocumentCorrectionError(
      "an attributable correction actor is required",
    );
  }

  return withOrg(input.orgId, async () =>
    db.transaction(async (tx) => {
      const locked = (await tx.execute<{ id: string }>(sql`
        select id
          from documents
         where id = ${input.sourceDocumentId}
           and org_id = ${input.orgId}
         for update
      `));
      const [source] = locked.rows[0]
        ? await tx
            .select()
            .from(schema.documents)
            .where(and(eq(schema.documents.id, input.sourceDocumentId), eq(schema.documents.orgId, input.orgId)))
        : [];
      if (!source) throw new DocumentCorrectionError("source document not found");

      const existing = (await tx.execute<{
          id: string;
          document_number: string;
          reason: string;
          requested_by: string;
        }>(sql`
        select replacement.id, replacement.document_number,
               link.reason, link.requested_by
          from document_links link
          join documents replacement
            on replacement.id = link.from_document_id
           and replacement.org_id = link.org_id
         where link.org_id = ${input.orgId}
           and link.to_document_id = ${source.id}
           and link.link_type = 'reverses'
         limit 1
      `));
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.document_number !== replacementDocumentNumber ||
          prior.reason !== reason ||
          prior.requested_by !== input.actorId
        ) {
          throw new DocumentCorrectionError(
            `${source.documentNumber} already has correction ${prior.document_number}; continue that retained correction instead of creating a competing version`,
          );
        }
        return {
          sourceDocumentId: source.id,
          replacementDocumentId: prior.id,
          replacementDocumentNumber: prior.document_number,
          created: false,
        };
      }
      if (source.status !== "posted" || !source.postedEntryId) {
        throw new DocumentCorrectionError(
          `${source.documentNumber} is ${source.status}; only a posted document can be corrected`,
        );
      }

      const duplicateNumber = (await tx.execute<{ id: string }>(sql`
        select id
          from documents
         where org_id = ${input.orgId}
           and kind = ${source.kind}
           and document_number = ${replacementDocumentNumber}
         limit 1
      `));
      if (duplicateNumber.rows[0]) {
        throw new DocumentCorrectionError(
          `${replacementDocumentNumber} is already in use for ${source.kind}`,
        );
      }

      const replacementId = randomUUID();
      await tx.insert(schema.documents).values({
        id: replacementId,
        orgId: source.orgId,
        kind: source.kind,
        documentNumber: replacementDocumentNumber,
        partyId: source.partyId,
        subsidiaryId: source.subsidiaryId,
        documentDate: source.documentDate,
        postingDate: source.postingDate,
        postingPeriodId: source.postingPeriodId,
        dueDate: source.dueDate,
        currency: source.currency,
        fxRate: source.fxRate,
        status: "draft",
        subtotal: source.subtotal,
        taxTotal: source.taxTotal,
        total: source.total,
        openBalance: null,
        departmentId: source.departmentId,
        projectId: source.projectId,
        locationId: source.locationId,
        classId: source.classId,
        extraDims: source.extraDims,
        paymentCardId: source.paymentCardId,
        billingMethod: source.billingMethod,
        isFinalInvoice: source.isFinalInvoice,
        referenceNumber: source.referenceNumber,
        internalNotes: source.internalNotes,
        paymentHoldReason: source.paymentHoldReason,
        expectedPayDate: source.expectedPayDate,
        memo: source.memo,
        custom: source.custom,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      });

      const sourceLines = await tx
        .select()
        .from(schema.documentLines)
        .where(and(eq(schema.documentLines.documentId, source.id), eq(schema.documentLines.orgId, input.orgId)));
      const lineIds = new Map<string, string>();
      for (const line of sourceLines) {
        const lineId = randomUUID();
        lineIds.set(line.id, lineId);
        await tx.insert(schema.documentLines).values({
          id: lineId,
          orgId: line.orgId,
          documentId: replacementId,
          lineNumber: line.lineNumber,
          itemId: line.itemId,
          accountId: line.accountId,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          amount: line.amount,
          taxCodeId: line.taxCodeId,
          taxGroupId: line.taxGroupId,
          taxInputAmount: line.taxInputAmount,
          taxAmount: line.taxAmount,
          taxOverridden: line.taxOverridden,
          partyId: line.partyId,
          departmentId: line.departmentId,
          projectId: line.projectId,
          locationId: line.locationId,
          classId: line.classId,
          subsidiaryId: line.subsidiaryId,
          extraDims: line.extraDims,
          employeeId: line.employeeId,
          timeEntryId: line.timeEntryId,
          timeTypeId: line.timeTypeId,
          costMultiplier: line.costMultiplier,
          markupPercent: line.markupPercent,
          isBillable: line.isBillable,
          // Downstream fulfillment/billing state belongs to the retained source,
          // not to a newly created accounting version.
          billedByLineId: null,
          fieldTicketId: line.fieldTicketId,
          equipmentUnitId: line.equipmentUnitId,
          rateVersionId: line.rateVersionId,
          ratePresentation: line.ratePresentation,
          baseQuantity: line.baseQuantity,
          baseUnit: line.baseUnit,
          costRate: line.costRate,
          billRate: line.billRate,
          costAmount: line.costAmount,
          billAmount: line.billAmount,
          recoveryAccountId: line.recoveryAccountId,
          quantityFulfilled: "0",
          quantityBilled: "0",
          stockLocationId: line.stockLocationId,
          custom: line.custom,
          createdBy: input.actorId,
          updatedBy: input.actorId,
        });
      }

      for (const [sourceLineId, replacementLineId] of lineIds) {
        const components = await tx
          .select()
          .from(schema.documentLineTaxComponents)
          .where(
            eq(
              schema.documentLineTaxComponents.documentLineId,
              sourceLineId,
            ),
          );
        if (components.length) {
          await tx.insert(schema.documentLineTaxComponents).values(
            components.map((component) => ({
              orgId: component.orgId,
              documentLineId: replacementLineId,
              taxCodeId: component.taxCodeId,
              sequence: component.sequence,
              ratePercent: component.ratePercent,
              taxableAmount: component.taxableAmount,
              taxAmount: component.taxAmount,
              recoverableAmount: component.recoverableAmount,
              nonrecoverableAmount: component.nonrecoverableAmount,
              calculationType: component.calculationType,
              priceIncludesTax: component.priceIncludesTax,
              compoundOnPrevious: component.compoundOnPrevious,
              roundingScale: component.roundingScale,
              collectedAccountId: component.collectedAccountId,
              paidAccountId: component.paidAccountId,
              withholdingAccountId: component.withholdingAccountId,
              overridden: component.overridden,
              createdBy: input.actorId,
              updatedBy: input.actorId,
            })),
          );
        }
      }

      const [link] = await tx
        .insert(schema.documentLinks)
        .values({
          orgId: input.orgId,
          fromDocumentId: replacementId,
          toDocumentId: source.id,
          linkType: "reverses",
          reason,
          requestedBy: input.actorId,
          requestedAt: new Date(),
          createdBy: input.actorId,
          updatedBy: input.actorId,
        })
        .returning({ id: schema.documentLinks.id });

      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${input.orgId}, 'documents', ${replacementId}, 'insert',
          ${JSON.stringify({
            mode: "append_only_document_correction",
            sourceDocumentId: source.id,
            sourceEntryId: source.postedEntryId,
            replacementDocumentId: replacementId,
            replacementDocumentNumber,
            correctionLinkId: link.id,
            reason,
          })}::jsonb,
          ${input.actorId}, 'document_correction'
        )
      `);

      return {
        sourceDocumentId: source.id,
        replacementDocumentId: replacementId,
        replacementDocumentNumber,
        created: true,
      };
    }),
  );
}
