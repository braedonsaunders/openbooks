import { sql } from "drizzle-orm";
import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { decimalNullRefusal } from "../../money/decimal-refusal.ts";
import { cmp, normalizeMoney } from "../../money/money.ts";
import { db } from "../../platform/db.ts";
import { PayrollError } from "../error.ts";
import {
  employeeTaxYearFenceKey,
  takeEmployeeTaxYearFences,
} from "../fences.ts";
import {
  assertTaxYear,
  openingBalanceLocks,
} from "../opening-balances.ts";
import type { PayrollSubsidiaryScope } from "../scope.ts";

/**
 * The assessed-saldo carry-in save (migration 0393): one row
 * per (org, employee, tax year) in it_addizionali_opening_balances holding
 * the prior-year assessment the year's installments withhold.
 *
 * Separate from the generic opening-balances save on purpose: that save
 * deletes all-zero rows ("zero is no carry-in, not a row"), which is correct
 * for year-to-date history but would make an explicit assessed zero — the
 * exact remedy the installment channel names for a worker with no prior-year
 * Italian employment — unrecordable. Here row presence IS the declaration, so
 * explicit zeros persist beside nonzero history, and clearing is an explicit
 * delete (both amounts sent null), never a quiet zero.
 *
 * The sibling controls ride along, because either one enforced only by a
 * screen is not enforced:
 * 1. A carry-in is IMMUTABLE for an employee/tax-year once a run has
 *    committed for them in that year (same committed-stub lock as the
 *    generic save — the installments were priced off these figures).
 * 2. Amounts are exact money via canonicalDecimal with NO separator
 *    stripping (a comma may be a decimal comma), never negative, refused
 *    through the shared decimal classifier — never a second one.
 * Every write lands in audit_log with before/after, like the generic save.
 */

/** One employee's assessed saldo write. Null amounts clear the row. */
export interface SurtaxSaldoCarryInWrite {
  employeePartyId: string;
  regionaleSaldo: unknown;
  comunaleSaldo: unknown;
}

export interface SurtaxSaldoSaveResult {
  created: number;
  updated: number;
  deleted: number;
  errors: { employeePartyId: string; message: string }[];
}

/** Carries every rejected row out of the aborted transaction. */
export class SurtaxSaldoSaveError extends PayrollError {
  constructor(readonly result: SurtaxSaldoSaveResult) {
    super(result.errors[0]?.message ?? "surtax saldo carry-ins were rejected");
  }
}

/** One employee's stored assessed saldo, for the carry-in grid. */
export interface SurtaxSaldoCarryIn {
  employeePartyId: string;
  regionaleSaldo: string;
  comunaleSaldo: string;
}

/**
 * Read the year's assessed rows for the grid. Plain map by employee; the grid
 * merges these under its own IT-only columns (the generic opening-balances
 * layer never names this table).
 */
export async function itSurtaxSaldoCarryIns(
  runner: Pick<typeof db, "execute">,
  orgId: string,
  taxYear: number,
): Promise<SurtaxSaldoCarryIn[]> {
  const rows = (await runner.execute<{
    employeePartyId: string;
    regionaleSaldo: string;
    comunaleSaldo: string;
  }>(sql`
    select employee_party_id as "employeePartyId",
           regionale_saldo::text as "regionaleSaldo",
           comunale_saldo::text as "comunaleSaldo"
      from it_addizionali_opening_balances
     where org_id = ${orgId} and tax_year = ${taxYear}`)).rows;
  return rows.map((row) => ({
    employeePartyId: String(row.employeePartyId),
    regionaleSaldo: String(row.regionaleSaldo),
    comunaleSaldo: String(row.comunaleSaldo),
  }));
}

function normalizeSaldo(label: string, raw: unknown): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const exact = canonicalDecimal(String(raw).trim(), 4);
  if (exact === null) {
    throw new PayrollError(decimalNullRefusal(label, "an amount", raw, 4));
  }
  let value: string;
  try {
    value = normalizeMoney(exact);
  } catch {
    throw new PayrollError(`${label} is not an amount: "${String(raw)}"`);
  }
  // An assessment is money owed, never less than zero. Negative is a
  // sign-flipped export, not history.
  if (cmp(value, "0") < 0) throw new PayrollError(`${label} cannot be negative`);
  return value;
}

async function auditSurtaxSaldo(
  runner: Pick<typeof db, "execute">,
  args: {
    orgId: string; actorId: string; rowId: string;
    action: "insert" | "update" | "delete";
    changes: Record<string, unknown>;
  },
): Promise<void> {
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'it_addizionali_opening_balances', ${args.rowId}, ${args.action},
            ${JSON.stringify(args.changes)}, ${args.actorId})`);
}

export async function saveItSurtaxSaldoCarryIns(input: {
  orgId: string;
  actorId: string;
  taxYear: number;
  rows: readonly SurtaxSaldoCarryInWrite[];
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<SurtaxSaldoSaveResult> {
  const year = assertTaxYear(input.taxYear);
  const result: SurtaxSaldoSaveResult = { created: 0, updated: 0, deleted: 0, errors: [] };
  return db.transaction(async (tx) => {
    // Serialize against concurrent payroll calculation for these employees:
    // a save that wins the fence commits first and the run's freshness gate
    // refuses the stale calculation. Never both.
    await takeEmployeeTaxYearFences(
      tx,
      input.rows.map((row) => employeeTaxYearFenceKey(input.orgId, row.employeePartyId, year)),
    );
    const locks = await openingBalanceLocks(input.orgId, year, tx, input.allowedSubsidiaryIds);

    for (const row of input.rows) {
      try {
        const lock = locks.get(row.employeePartyId);
        if (lock) {
          throw new PayrollError(
            `assessed saldo is locked by committed run ${lock.documentNumber ?? "unknown"} `
            + `(${lock.payDate}): the installments were priced off these figures — void the run to change them`,
          );
        }
        const regionale = normalizeSaldo("Addizionale regionale a saldo (anno precedente)", row.regionaleSaldo);
        const comunale = normalizeSaldo("Addizionale comunale a saldo (anno precedente)", row.comunaleSaldo);
        if (regionale === null && comunale === null) {
          const deleted = (await tx.execute<{ id: string }>(sql`
            delete from it_addizionali_opening_balances
             where org_id = ${input.orgId} and employee_party_id = ${row.employeePartyId}
               and tax_year = ${year}
             returning id`));
          for (const gone of deleted.rows) {
            result.deleted++;
            await auditSurtaxSaldo(tx, {
              orgId: input.orgId, actorId: input.actorId, rowId: gone.id,
              action: "delete", changes: { employeePartyId: row.employeePartyId, taxYear: year },
            });
          }
          continue;
        }
        const existing = (await tx.execute<{ id: string }>(sql`
          select id from it_addizionali_opening_balances
           where org_id = ${input.orgId} and employee_party_id = ${row.employeePartyId}
             and tax_year = ${year}
           limit 1`)).rows[0];
        const saved = (await tx.execute<{ id: string }>(sql`
          insert into it_addizionali_opening_balances
            (org_id, employee_party_id, tax_year, regionale_saldo, comunale_saldo, created_by, updated_by)
          values (${input.orgId}, ${row.employeePartyId}, ${year},
                  ${regionale ?? "0.0000"}, ${comunale ?? "0.0000"},
                  ${input.actorId}, ${input.actorId})
          on conflict (org_id, employee_party_id, tax_year) do update
             set regionale_saldo = excluded.regionale_saldo,
                 comunale_saldo = excluded.comunale_saldo,
                 updated_by = ${input.actorId},
                 updated_at = now()
           where it_addizionali_opening_balances.org_id = ${input.orgId}
          returning id`));
        const rowId = saved.rows[0]!.id;
        if (existing) result.updated++;
        else result.created++;
        await auditSurtaxSaldo(tx, {
          orgId: input.orgId, actorId: input.actorId, rowId,
          action: existing ? "update" : "insert",
          changes: {
            employeePartyId: row.employeePartyId, taxYear: year,
            regionaleSaldo: regionale ?? "0.0000", comunaleSaldo: comunale ?? "0.0000",
          },
        });
      } catch (error) {
        result.errors.push({
          employeePartyId: row.employeePartyId,
          message: error instanceof Error ? error.message : "invalid carry-in",
        });
      }
    }

    if (result.errors.length > 0) {
      // Nothing partial: raise so the transaction unwinds, carrying the full
      // error list back to the caller.
      throw new SurtaxSaldoSaveError(result);
    }
    return result;
  });
}
