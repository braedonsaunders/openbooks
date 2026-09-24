import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Shared scope for "posted return evidence against one source movement".
 *
 * Three readers must agree on what "already returned" means, or a source the
 * picker offered could be refused at posting (or a reversed return could
 * stay counted): the returnable-source picker lateral
 * (./returnable-sources.ts), the customer-credit guard
 * (./documents-customer-credits.ts), and the vendor-credit guard
 * (./documents-vendor-credits.ts). All three scope the same two aliases —
 * `prior` for the return movement, `credit_line` for its credit line — so
 * this one fragment serves every site.
 *
 * A return that was itself reversed is NOT evidence: reversing a
 * customer-return receipt restores the shipment's stock position, so the
 * units are returnable again. Reversals carry `reverses_movement_id` and no
 * document line of their own, which is also why the join stays inner.
 */
export type ReturnEvidenceKind = "receipt" | "return";
export type ReturnEvidenceKey = "sourceIssueMovementId" | "sourceReceiptMovementId";

export function postedReturnEvidenceScope(input: {
  orgId: string;
  returnKind: ReturnEvidenceKind;
  evidenceKey: ReturnEvidenceKey;
  /** Expression for the source movement id (a bound id, or `movement.id`). */
  sourceId: SQL;
}): SQL {
  return sql`
    prior.org_id = ${input.orgId}
    and prior.kind = ${input.returnKind}
    and prior.status = 'posted'
    and credit_line.custom #>> ${sql.raw(`'{inventoryReturn,${input.evidenceKey}}'`)} = ${input.sourceId}
    and not exists (
      select 1 from inventory_movements reversal
       where reversal.org_id = prior.org_id
         and reversal.reverses_movement_id = prior.id
    )`;
}

/**
 * Live quantity and value of one receipt movement: its own quantity and
 * total value net of posted, unreversed reversals pointing at it.
 * Reversals carry negated quantities and values under
 * `reverses_movement_id`, so a fully reversed receipt nets to zero and a
 * partially reversed one to its remainder; a reversal that was itself
 * reversed restores the stock and nets back, matching the returnable-source
 * picker's rule. Shared by goods-receipt coverage
 * (./documents-purchasing.ts) and the vendor-return source guard
 * (./documents-vendor-credits.ts) so a reversed receipt is dead for both:
 * the bill must receive it into layers exactly when the return flow
 * treats it as dead.
 */
export type LiveReceiptQuantity = {
  quantity: string;
  value: string;
};

export async function liveReceiptQuantity(
  runner: SqlExecutor,
  orgId: string,
  movementId: string,
): Promise<LiveReceiptQuantity> {
  const rows = (await runner.execute<LiveReceiptQuantity>(sql`
    select (coalesce((select m.quantity from inventory_movements m
                      where m.org_id = ${orgId} and m.id = ${movementId}), 0)
            + coalesce((select sum(r.quantity) from inventory_movements r
                         where r.org_id = ${orgId} and r.reverses_movement_id = ${movementId}
                           and r.status = 'posted'
                           and not exists (
                             select 1 from inventory_movements r2
                              where r2.org_id = r.org_id and r2.reverses_movement_id = r.id
                           )), 0))::text as quantity,
           (coalesce((select m.total_value from inventory_movements m
                      where m.org_id = ${orgId} and m.id = ${movementId}), 0)
            + coalesce((select sum(r.total_value) from inventory_movements r
                         where r.org_id = ${orgId} and r.reverses_movement_id = ${movementId}
                           and r.status = 'posted'
                           and not exists (
                             select 1 from inventory_movements r2
                              where r2.org_id = r.org_id and r2.reverses_movement_id = r.id
                           )), 0))::text as value`)).rows;
  return rows[0] ?? { quantity: "0", value: "0" };
}

/**
 * Absolute quantity already returned against one source movement by posted,
 * unreversed credit lines. Absolute values so the purchase side (negative
 * `return` movements) and the sales side (positive `receipt` movements)
 * compare directly against their source's absolute quantity.
 */
export async function postedReturnQuantity(
  runner: SqlExecutor,
  orgId: string,
  input: {
    returnKind: ReturnEvidenceKind;
    evidenceKey: ReturnEvidenceKey;
    sourceMovementId: string;
  },
): Promise<string> {
  const rows = (await runner.execute<{ quantity: string }>(sql`
    select coalesce(sum(abs(prior.quantity)), 0)::text as quantity
      from inventory_movements prior
      join document_lines credit_line
        on credit_line.id = prior.document_line_id
       and credit_line.org_id = prior.org_id
     where ${postedReturnEvidenceScope({
       orgId,
       returnKind: input.returnKind,
       evidenceKey: input.evidenceKey,
       sourceId: sql`${input.sourceMovementId}`,
     })}`)).rows;
  return rows[0]?.quantity ?? "0";
}
