import { sql } from "drizzle-orm";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { db, schema } from "../platform/db.ts";
import { toUnits, normalizeDecimal, normalizeMoney } from "../money/money.ts";
import { type NativeDocLine } from "./native.ts";
import {
  computeImportedLineTaxEvidence,
  loadTaxComponentConfig,
  persistLineTaxComponents,
} from "../tax/persist.ts";
import type { ComputedTaxComponent } from "../tax/tax.ts";
import { SyncTaxCodeError } from "./sync-run-locks.ts";
import { effectiveLineSubsidiary, effectiveTaxCodeId } from "./sync-document-identity.ts";

/** Derives header totals from document lines under the governed amend context. */
export async function refreshDocumentHeaderTotals(docId: string, orgId: string): Promise<void> {
  // Posted financial headers change only inside the governed amend transaction.
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local openbooks.amend = on`);
    await tx.execute(sql`
      update documents d set
        subtotal = w.want_subtotal,
        tax_total = w.want_tax,
        total = w.want_total
      from documents d2
      join lateral (
        select count(*)::int as line_count,
               coalesce(sum(l.amount), 0) as amount_sum,
               coalesce(sum(l.tax_amount), 0) as tax_sum,
               coalesce(sum(l.amount) filter (where l.amount > 0), 0) as debit_sum
          from document_lines l
         where l.document_id = d2.id and l.org_id = d2.org_id and l.org_id = ${orgId}) ls on true
      join lateral (
        select case when d2.kind in ('journal', 'pay_run')
                    then ls.debit_sum - ls.tax_sum else ls.amount_sum end as want_subtotal,
               ls.tax_sum as want_tax,
               case when d2.kind in ('journal', 'pay_run')
                    then ls.debit_sum else ls.amount_sum + ls.tax_sum end as want_total) w on true
      where d.id = d2.id and d2.id = ${docId}
        and d.org_id = ${orgId} and d2.org_id = ${orgId}
        -- 0017 returns early for a document with no lines, so leave those alone
        -- rather than stamping zeros over a header it does not govern.
        and ls.line_count > 0
    `);
  });
}

export type SyncTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Build the immutable tax snapshots before mutating a document. */
export async function importedTaxEvidence(
  orgId: string,
  documentDate: string,
  lines: NativeDocLine[],
  sourceRef: string,
): Promise<Map<number, ComputedTaxComponent[]>> {
  for (const line of lines) {
    if (toUnits(line.taxAmount) !== 0n && !line.taxCodeId) {
      throw new SyncTaxCodeError(sourceRef, line.lineNumber, line.taxAmount);
    }
  }
  const configs = new Map<string, Awaited<ReturnType<typeof loadTaxComponentConfig>>>();
  for (const taxCodeId of new Set(
    lines
      .map((line) => effectiveTaxCodeId(line.taxAmount, line.taxCodeId))
      .filter((id): id is string => Boolean(id)),
  )) {
    const config = await loadTaxComponentConfig(orgId, taxCodeId, documentDate);
    if (config.length === 0)
      throw new Error(`tax code ${taxCodeId} has no effective calculation configuration`);
    configs.set(taxCodeId, config);
  }
  const evidence = new Map<number, ComputedTaxComponent[]>();
  for (const line of lines) {
    const taxCodeId = effectiveTaxCodeId(line.taxAmount, line.taxCodeId);
    if (!taxCodeId) continue;
    evidence.set(
      line.lineNumber,
      computeImportedLineTaxEvidence(line.amount, line.taxAmount, configs.get(taxCodeId)!),
    );
  }
  return evidence;
}

/** Persist a synced money field through exact decimal then ledger money. Fail closed. */
export function persistSyncLineMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error(`${label} must be an exact decimal`);
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error(`${label} must be an exact decimal`);
  }
}

/** Preserves numeric(28,8) precision for quantities and unit prices. */
export function persistSyncLineQuantity(value: unknown, label: string): string {
  try {
    return normalizeDecimal(String(value), 8);
  } catch {
    throw new Error(`${label} must be an exact decimal`);
  }
}

/** Persist a synced document FX rate through exact decimal at numeric(19,10). Fail closed. */
export function persistSyncFxRate(value: unknown): string {
  const exact = canonicalDecimal(value, 10);
  if (exact === null) throw new Error("FX rate must be an exact decimal");
  try {
    return normalizeDecimal(exact, 10);
  } catch {
    throw new Error("FX rate must be an exact decimal");
  }
}

/** Custom-field values survive replacement of the same source line, including removal of a mapping rule. */
export async function preservedImportedLineCustom(
  tx: SyncTx,
  orgId: string,
  documentId: string,
): Promise<Map<string, Record<string, unknown>>> {
  const rows = await tx.execute<{ line_number: number; custom: Record<string, unknown> }>(
    sql`select line_number,custom from document_lines where org_id=${orgId} and document_id=${documentId} for update`,
    "objects",
  );
  const output = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key =
      typeof row.custom.sourceLineRef === "string"
        ? row.custom.sourceLineRef
        : `line:${row.line_number}`;
    if (output.has(key)) throw new Error("Stored source line identity is ambiguous");
    const { connectorMappedValues: _ownership, ...values } = row.custom;
    output.set(key, values);
  }
  return output;
}

/** Insert source lines and their tax evidence in the caller's transaction. */
export async function insertImportedLines(
  tx: SyncTx,
  orgId: string,
  documentId: string,
  lines: NativeDocLine[],
  evidence: Map<number, ComputedTaxComponent[]>,
  preservedCustom = new Map<string, Record<string, unknown>>(),
): Promise<void> {
  const fieldTicketByLine = new Map<number, string>();
  for (const line of lines) {
    const sourceSystem = line.fieldTicketSourceSystem?.trim() ?? "";
    const sourceRef = line.fieldTicketSourceRef?.trim() ?? "";
    if (!sourceSystem && !sourceRef) continue;
    if (!sourceSystem || !sourceRef) {
      throw new Error(
        `field ticket link on line ${line.lineNumber} needs both source system and source reference`,
      );
    }
    if (!line.projectId) {
      throw new Error(
        `field ticket source ${sourceSystem}:${sourceRef} on line ${line.lineNumber} has no project identity to validate`,
      );
    }
    const matches = await tx.execute<{
      document_id: string;
      project_id: string | null;
      subsidiary_id: string | null;
      parent_subsidiary_id: string | null;
    }>(
      sql`
      select ticket.id::text as document_id, ticket.project_id::text as project_id,
             ticket.subsidiary_id::text as subsidiary_id, parent.subsidiary_id::text as parent_subsidiary_id
        from field_tickets ft
        join documents ticket on ticket.org_id = ft.org_id and ticket.id = ft.document_id
        join documents parent on parent.org_id = ft.org_id and parent.id = ${documentId}
       where ft.org_id = ${orgId}
         and ticket.kind = 'field_ticket'
         and ticket.custom->'source'->>'system' = ${sourceSystem}
         and ticket.custom->'source'->>'externalId' = ${sourceRef}
       limit 2 for share of ticket, ft
    `,
      "objects",
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `field ticket source ${sourceSystem}:${sourceRef} on line ${line.lineNumber} is not imported in this organization`
          : `field ticket source ${sourceSystem}:${sourceRef} resolves to multiple native tickets; reconcile the source identities before import`,
      );
    }
    const ticket = matches[0]!;
    if (ticket.project_id !== line.projectId) {
      throw new Error(
        `field ticket source ${sourceSystem}:${sourceRef} on line ${line.lineNumber} belongs to a different project`,
      );
    }
    const lineEntity = effectiveLineSubsidiary(line.subsidiaryId, ticket.parent_subsidiary_id);
    if (!ticket.subsidiary_id || ticket.subsidiary_id !== lineEntity) {
      throw new Error(
        `field ticket source ${sourceSystem}:${sourceRef} on line ${line.lineNumber} belongs to a different or unknown legal entity`,
      );
    }
    fieldTicketByLine.set(line.lineNumber, ticket.document_id);
  }
  const inserted = await tx
    .insert(schema.documentLines)
    .values(
      lines.map((line) => ({
        orgId,
        documentId,
        lineNumber: line.lineNumber,
        accountId: line.accountId,
        itemId: line.itemId,
        quantity: persistSyncLineQuantity(line.quantity ?? "1", "quantity"),
        unit: line.unit ?? null,
        unitPrice: persistSyncLineQuantity(line.unitPrice ?? line.amount, "unit price"),
        amount: persistSyncLineMoney(line.amount, "amount"),
        taxCodeId: effectiveTaxCodeId(line.taxAmount, line.taxCodeId),
        taxAmount: persistSyncLineMoney(line.taxAmount, "tax amount"),
        taxOverridden: line.taxOverridden,
        partyId: line.partyId ?? null,
        departmentId: line.departmentId,
        projectId: line.projectId,
        fieldTicketId: fieldTicketByLine.get(line.lineNumber) ?? null,
        subsidiaryId: line.subsidiaryId,
        extraDims: line.extraDims ?? {},
        description: line.description,
        isBillable: line.isBillable ?? false,
        markupPercent: line.markupPercent ?? null,
        billAmount:
          line.billAmount == null ? null : persistSyncLineMoney(line.billAmount, "bill amount"),
        // Line identity from the source system, so a migrated document can be
        // reconciled and re-synced line by line rather than only as a whole.
        custom: {
          ...preservedCustom.get(line.sourceLineRef ?? `line:${line.lineNumber}`),
          ...(line.sourceLineRef ? { sourceLineRef: line.sourceLineRef } : {}),
          ...line.mappedCustom,
          ...(Object.keys(line.mappedCustom ?? {}).length
            ? { connectorMappedValues: line.mappedCustom }
            : {}),
        },
      })),
    )
    .returning({
      id: schema.documentLines.id,
      lineNumber: schema.documentLines.lineNumber,
    });
  for (const line of inserted) {
    const components = evidence.get(line.lineNumber) ?? [];
    if (components.length > 0) {
      await persistLineTaxComponents(orgId, line.id, components, null, tx);
    }
  }
}
