import { sql } from "drizzle-orm";
import { persistGoodsTaxSnapshot } from "@openbooks/engine/tax";
import type { EntryPlan } from "../journal/entry-allocation-plan.ts";
import { persistLineTaxComponents } from "./document-totals.ts";
import { persistTaxQuote } from "../tax/rate-providers.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import type {
  DocumentEditContext,
  DocumentTransaction,
  GeneratedWithholdingUpdate,
  PreparedDocumentLine,
} from "./document-write-context.ts";

/** Write identity-matched withholding inputs onto a generated bill's own lines. */
export async function writeGeneratedWithholdingInputs(
  tx: DocumentTransaction,
  args: {
    ctx: DocumentEditContext;
    orgId: string;
    id: string;
    generatedWithholdingUpdates: GeneratedWithholdingUpdate[];
  },
): Promise<void> {
  const { ctx, orgId, id, generatedWithholdingUpdates } = args;
  for (const line of generatedWithholdingUpdates) {
    const updated = await tx.execute<never>(sql`update document_lines
          set withholding_treatment=${line.treatment ?? null}, withholding_materials_cost=${line.cost},
              updated_by=${ctx.userId}, updated_at=now()
          where org_id=${orgId} and document_id=${id} and id=${line.id}`);
    if (updated.rowCount !== 1)
      throw new DocumentEditError(
        409,
        "The generated bill line changed; reload the bill before saving",
      );
  }
}

/** Persisted line identity a replacement row may inherit from its submitted source line. */
type LineProvenanceRow = {
  id: string;
  timeEntryId: string | null;
  employeeId: string | null;
  timeTypeId: string | null;
  equipmentUnitId: string | null;
  rateVersionId: string | null;
  billRate: string | null;
  billAmount: string | null;
  promotionId: string | null;
  workFrom: string | null;
  workTo: string | null;
};

type LineReference = { id: string; oldId: string };

// Billed-time/cost provenance the editor's column set cannot express
// a billing-generated invoice's lines are referenced by
// time_entries.invoiced_by_line_id and by source cost lines'
// billed_by_line_id, so a blind delete dies on those FKs as a raw
// 500 — and would strand the provenance even if it did not. Snapshot
// the persisted line identity. Replacement rows inherit only their
// submitted source identity, so reordering and deletion cannot move
// labor, cost or work-period evidence onto an unrelated line.
export async function replaceDocumentLines(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    userId: string;
    id: string;
    preparedLines: PreparedDocumentLine[];
    submittedLineKeys: (string | null)[] | null;
    entryPlan: EntryPlan | null;
  },
): Promise<void> {
  const { orgId, id, entryPlan } = args;
  const { provenanceById, timeRefs, costRefs, promotionsByLine } = await lockLineProvenance(
    tx,
    args,
  );
  const { insertedLineIds, replacementById } = await insertReplacementLines(tx, {
    ...args,
    provenanceById,
    promotionsByLine,
  });
  await insertEntryLineage(tx, { orgId, id, entryPlan, insertedLineIds });
  await repointLineReferences(tx, { orgId, timeRefs, costRefs, replacementById });
}

/**
 * Lock the inbound billed-time and billed-cost references, and refuse a save
 * that could not carry protected provenance by line identity.
 */
async function lockLineProvenance(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    preparedLines: PreparedDocumentLine[];
    submittedLineKeys: (string | null)[] | null;
    entryPlan: EntryPlan | null;
  },
): Promise<{
  provenanceById: Map<string, LineProvenanceRow>;
  timeRefs: LineReference[];
  costRefs: LineReference[];
  promotionsByLine: Map<string, string | null>;
}> {
  const { orgId, id, preparedLines, submittedLineKeys, entryPlan } = args;
  const provenance = await tx.execute<{
    id: string;
    timeEntryId: string | null;
    employeeId: string | null;
    timeTypeId: string | null;
    equipmentUnitId: string | null;
    rateVersionId: string | null;
    billRate: string | null;
    billAmount: string | null;
    promotionId: string | null;
    workFrom: string | null;
    workTo: string | null;
  }>(
    sql`
          select id, time_entry_id as "timeEntryId", employee_id as "employeeId",
                 time_type_id as "timeTypeId", equipment_unit_id as "equipmentUnitId",
                 rate_version_id as "rateVersionId",
                 bill_rate::text as "billRate", bill_amount::text as "billAmount", promotion_id as "promotionId",
                 work_from::text as "workFrom", work_to::text as "workTo"
            from document_lines
           where document_id = ${id} and org_id = ${orgId}
           order by line_number
        `,
    "objects",
  );
  const provenanceById = new Map(provenance.map((line) => [line.id.toLowerCase(), line]));
  const oldIds = `{${provenance.map((line) => line.id).join(",")}}`;
  const timeRefs = await tx.execute<{ id: string; oldId: string }>(
    sql`
          select id, invoiced_by_line_id as "oldId" from time_entries
          where org_id=${orgId} and invoiced_by_line_id=any(${oldIds}::uuid[])
          order by id for update`,
    "objects",
  );
  const costRefs = await tx.execute<{ id: string; oldId: string }>(
    sql`
          select id, billed_by_line_id as "oldId" from document_lines
          where org_id=${orgId} and billed_by_line_id=any(${oldIds}::uuid[])
          order by id for update`,
    "objects",
  );
  const hasProtectedProvenance =
    timeRefs.length > 0 ||
    costRefs.length > 0 ||
    provenance.some(
      (line) =>
        line.timeEntryId !== null ||
        line.employeeId !== null ||
        line.timeTypeId !== null ||
        line.equipmentUnitId !== null ||
        line.rateVersionId !== null ||
        line.billRate !== null ||
        line.billAmount !== null ||
        line.workFrom !== null ||
        line.workTo !== null,
    );
  if (
    hasProtectedProvenance &&
    preparedLines.length > 0 &&
    (submittedLineKeys?.length !== preparedLines.length ||
      submittedLineKeys.every((key) => key === null) ||
      entryPlan?.exploded === true)
  ) {
    throw new DocumentEditError(
      422,
      "This draft retains billed work or cost evidence; reload it and save its existing line identities. Source-bound lines cannot be redistributed by an entry allocation.",
    );
  }
  const promotionsByLine = new Map(
    provenance.filter((line) => line.promotionId).map((line) => [line.id, line.promotionId]),
  );
  if (
    promotionsByLine.size > 0 &&
    preparedLines.length > 0 &&
    (submittedLineKeys?.length !== preparedLines.length ||
      submittedLineKeys.every((key) => key === null))
  ) {
    throw new DocumentEditError(
      422,
      "This draft has promotion discount lines; reload it and save each existing line with its lineId so its promotion remains attached",
    );
  }
  return { provenanceById, timeRefs, costRefs, promotionsByLine };
}

/** Replace the lines with the prepared set, carrying each source line's identity-bound provenance. */
async function insertReplacementLines(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    userId: string;
    id: string;
    preparedLines: PreparedDocumentLine[];
    submittedLineKeys: (string | null)[] | null;
    provenanceById: Map<string, LineProvenanceRow>;
    promotionsByLine: Map<string, string | null>;
  },
): Promise<{ insertedLineIds: string[]; replacementById: Map<string, string> }> {
  const { orgId, userId, id, preparedLines, submittedLineKeys, provenanceById, promotionsByLine } =
    args;
  const replacementById = new Map<string, string>();
  // Every FK around document lines is deferrable: hold inbound
  // provenance checks until commit, when the re-point below has
  // restored them onto the replacement rows. Any other inbound
  // reference still fails the commit — fail closed, never dangling.
  await tx.execute(sql`set constraints all deferred`);
  await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${orgId}`);
  const insertedLineIds: string[] = [];
  for (let i = 0; i < preparedLines.length; i++) {
    const l = preparedLines[i]!;
    const sourceLineId = submittedLineKeys?.[i] ?? null;
    const carry = sourceLineId ? provenanceById.get(sourceLineId) : undefined;
    // A carried billable-value snapshot follows the edit: the snapshot
    // columns mirror the commercial price (as generation writes them),
    // so leaving a stale zero behind would corrupt the earned views
    // that prefer bill_amount over amount. Lines that never carried a
    // snapshot keep null rather than inventing one.
    const billRate = carry?.billRate != null ? (l.unitPrice ?? l.amount) : null;
    const billAmount = carry?.billAmount != null ? l.amount : null;
    // A line submitted without its work period keeps the one it had
    // (generated invoices carry it); submitting either bound sets both.
    const workPeriodSubmitted = l.workFrom !== undefined || l.workTo !== undefined;
    const inserted = await tx.execute<{ id: string }>(
      sql`
            insert into document_lines (org_id, document_id, line_number, account_id, item_id, description,
                                        quantity, unit, unit_price, amount, tax_code_id, tax_group_id, tax_input_amount,
                                        tax_amount, tax_overridden, withholding_treatment, withholding_materials_cost, marketplace_facilitator,
                                        party_id, department_id, project_id, location_id, class_id,
                                        stock_location_id, extra_dims, custom,
                                        distribution_group_id, distribution_rule_id, distribution_version_id,
                                        distribution_locked,
                                        time_entry_id, employee_id, time_type_id,
                                        equipment_unit_id, rate_version_id, bill_rate, bill_amount, promotion_id,
                                        work_from, work_to,
                                        amortization_template_id, amortization_start_on, amortization_end_on)
            values (${orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.itemId}, ${l.description},
                    ${l.quantity ?? "1"}, ${l.unit}, ${l.unitPrice ?? l.amount}, ${l.amount},
                    ${l.taxCodeId}, ${l.taxGroupId}, ${l.taxInputAmount}, ${l.taxAmount}, ${l.taxOverridden}, ${l.withholdingTreatment}, ${l.withholdingMaterialsCost}, ${l.marketplaceFacilitator},
                    ${l.partyId}, ${l.departmentId}, ${l.projectId}, ${l.locationId}, ${l.classId},
                    ${l.stockLocationId}, ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)},
                    ${l.distributionGroupId}, ${l.distributionRuleId}, ${l.distributionVersionId},
                    ${l.distributionLocked},
                    ${carry?.timeEntryId ?? null}, ${carry?.employeeId ?? null}, ${carry?.timeTypeId ?? null},
                    ${carry?.equipmentUnitId ?? null}, ${carry?.rateVersionId ?? null}, ${billRate}, ${billAmount},
                    ${promotionsByLine.get(submittedLineKeys?.[i] ?? "") ?? null},
                    ${workPeriodSubmitted ? (l.workFrom ?? null) : (carry?.workFrom ?? null)},
                    ${workPeriodSubmitted ? (l.workTo ?? null) : (carry?.workTo ?? null)},
                    ${l.amortizationTemplateId}, ${l.amortizationStartOn}, ${l.amortizationEndOn})
            returning id
          `,
      "objects",
    );
    if (inserted.length !== 1)
      throw new DocumentEditError(
        409,
        "The replacement line was not saved; reload the draft before retrying",
      );
    insertedLineIds.push(inserted[0]!.id);
    if (sourceLineId) replacementById.set(sourceLineId, inserted[0]!.id);
    await persistLineTaxComponents(tx, {
      orgId,
      documentLineId: inserted[0]!.id,
      components: l.taxComponents,
      actorId: userId,
    });
    if (l.nativeGoodsTax)
      await persistGoodsTaxSnapshot(tx, orgId, inserted[0]!.id, l.nativeGoodsTax, userId);
    if (l.providerQuote) {
      await persistTaxQuote(
        orgId,
        l.providerQuote.providerConfigId,
        { ...l.providerQuote.request, documentLineId: inserted[0]!.id },
        l.providerQuote.result,
        userId,
        tx,
      );
      await tx.execute(sql`
              update tax_rate_provider_configs
                 set last_attempt_at = now(), last_success_at = now(), last_error = null
               where id = ${l.providerQuote.providerConfigId} and org_id = ${orgId}
            `);
    }
  }
  return { insertedLineIds, replacementById };
}

// Entry-mode lineage rows land in the same transaction as the child
// lines they explain: mode 'entry' anchored on the document, with
// the replaced source line (regenerations) and the new child target.
async function insertEntryLineage(
  tx: DocumentTransaction,
  args: { orgId: string; id: string; entryPlan: EntryPlan | null; insertedLineIds: string[] },
): Promise<void> {
  const { orgId, id, entryPlan, insertedLineIds } = args;
  if (entryPlan && entryPlan.lineage.length > 0) {
    for (const row of entryPlan.lineage) {
      const childId = insertedLineIds[row.targetLineIndex];
      if (!childId) {
        throw new Error(
          `entry allocation lineage pointed past the inserted lines (index ${row.targetLineIndex})`,
        );
      }
      if (!row.definitionHash) {
        throw new Error("entry allocation lineage is missing its definition hash");
      }
      await tx.execute(sql`
              insert into allocation_lineage
                (org_id, mode, rule_id, version_id, definition_hash, document_id,
                 source_document_line_id, target_document_line_id, driver_id,
                 driver_value, driver_total, share, amount, residual)
              values (${orgId}, 'entry', ${row.ruleId}, ${row.versionId}, ${row.definitionHash}, ${id},
                      ${row.sourceDocumentLineId ?? null}, ${childId}, ${row.driverId ?? null},
                      ${row.driverValue ?? null}, ${row.driverTotal ?? null}, ${row.share ?? null},
                      ${row.amount}, ${row.residual})
            `);
    }
  }
}

// Relational sources follow their exact retained line, not its former
// position. Omitted persisted identities release only their own work.
async function repointLineReferences(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    timeRefs: LineReference[];
    costRefs: LineReference[];
    replacementById: Map<string, string>;
  },
): Promise<void> {
  const { orgId, timeRefs, costRefs, replacementById } = args;
  for (const reference of timeRefs) {
    const target = replacementById.get(reference.oldId) ?? null;
    const moved = await tx.execute(
      target
        ? sql`update time_entries set invoiced_by_line_id=${target}
                where org_id=${orgId} and id=${reference.id} and invoiced_by_line_id=${reference.oldId} returning id`
        : sql`update time_entries set invoiced_by_line_id=null,billing_status='unbilled'
                where org_id=${orgId} and id=${reference.id} and invoiced_by_line_id=${reference.oldId} returning id`,
      "objects",
    );
    if (moved.length !== 1)
      throw new DocumentEditError(
        409,
        "A billed time source changed; reload the draft before saving",
      );
  }
  if (costRefs.length > 0) {
    // Native paired authority changes provenance metadata only; the
    // source document's posted financial values remain immutable.
    await tx.execute(sql`set local openbooks.migration = on`);
    await tx.execute(sql`set local openbooks.amend = on`);
    try {
      for (const reference of costRefs) {
        const target = replacementById.get(reference.oldId) ?? null;
        const moved = await tx.execute(
          sql`update document_lines set billed_by_line_id=${target}
                where org_id=${orgId} and id=${reference.id} and billed_by_line_id=${reference.oldId} returning id`,
          "objects",
        );
        if (moved.length !== 1)
          throw new DocumentEditError(
            409,
            "A billed cost source changed; reconcile its retained billing identity before saving",
          );
      }
    } finally {
      await tx.execute(sql`set local openbooks.migration = off`);
      await tx.execute(sql`set local openbooks.amend = off`);
    }
  }
}
