import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/** One journal_lines row as both journal writers insert it. */
export interface JournalLineWrite {
  lineNumber: number;
  accountId: string;
  subsidiaryId: string;
  /** Signed base amount: positive = debit, negative = credit. */
  amount: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
  memo?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  equipmentUnitId?: string | null;
  paymentCardId?: string | null;
  taxCodeId?: string | null;
  extraDims?: Record<string, unknown> | null;
  quantity?: string | null;
  unit?: string | null;
  eliminate?: boolean;
  isCurrencyAdjustment?: boolean;
  dueDate?: string | null;
  isOpenItem?: boolean;
  custom?: Record<string, unknown>;
  contributorKind?: string | null;
  contributorRef?: string | null;
}

/**
 * Inserts every line of the entry in ONE multi-row statement, which the statement-level balance
 * triggers rely on to validate each touched entry once. Returns the rows in statement order; a
 * short count throws `refusal`.
 */
export async function insertEntryLines(
  executor: SqlExecutor,
  entry: { orgId: string; entryId: string },
  lines: readonly JournalLineWrite[],
  options: { admitInactiveAccounts?: boolean; refusal: (inserted: number) => Error },
): Promise<{ id: string; lineNumber: number }[]> {
  const tuples = lines.map(
    (line) => sql`(
      ${entry.orgId}, ${entry.entryId}, ${line.lineNumber}, ${line.accountId}, ${line.subsidiaryId},
      ${line.amount}, ${line.currency}, ${line.txnAmount}, ${line.fxRate},
      ${line.memo ?? null}, ${line.partyId ?? null}, ${line.departmentId ?? null},
      ${line.projectId ?? null}, ${line.locationId ?? null}, ${line.classId ?? null},
      ${line.equipmentUnitId ?? null}, ${line.paymentCardId ?? null},
      ${JSON.stringify(line.extraDims ?? {})}::jsonb,
      ${line.quantity ?? null}, ${line.unit ?? null}, ${line.eliminate ?? false}, ${line.isCurrencyAdjustment ?? false}, ${line.dueDate ?? null},
      ${line.isOpenItem ?? false}, ${line.taxCodeId ?? null},
      ${line.custom === undefined ? "{}" : JSON.stringify(line.custom)}::jsonb,
      ${line.contributorKind ?? null}, ${line.contributorRef ?? null})`,
  );
  // Preserve an enclosing migration's authority for the entry's posted transition.
  // Standalone callers admit inactive accounts only inside this local bracket.
  let priorMigration: string | null = null;
  if (options.admitInactiveAccounts) {
    const [context] = await executor.execute<{ migration: string | null }>(
      sql`select current_setting('openbooks.migration', true) as migration`,
      "objects",
    );
    if (!context) throw new Error("The journal's migration context could not be read");
    priorMigration = context.migration;
    await executor.execute(sql`select set_config('openbooks.migration', 'on', true)`);
  }
  const inserted = await executor.execute<{ id: string; line_number: number }>(
    sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
         memo, party_id, department_id, project_id, location_id, class_id, equipment_unit_id, payment_card_id,
         extra_dims, quantity, unit, eliminate, is_currency_adjustment, due_date, is_open_item, tax_code_id, custom, contributor_kind, contributor_ref)
      values ${sql.join(tuples, sql`, `)}
      returning id, line_number`,
    "objects",
  );
  if (options.admitInactiveAccounts) {
    await executor.execute(
      sql`select set_config('openbooks.migration', ${priorMigration ?? ""}, true)`,
    );
  }
  if (inserted.length !== lines.length) throw options.refusal(inserted.length);
  return inserted.map((row) => ({ id: row.id, lineNumber: row.line_number }));
}
