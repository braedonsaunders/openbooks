import { sql, type SQL } from "drizzle-orm";

/**
 * Which carrying column an application consumes through each of its legs.
 * A to-leg settles its line in the TARGET columns (`amount`,
 * `target_transaction_amount`); a from-leg is consumed in the SOURCE columns
 * (`source_amount`, `source_transaction_amount`) — exactly the caps the
 * `app_check_open` trigger enforces and the split the maintained
 * `document_open_balance_amount` cache computes. Reading `amount` for both
 * legs mixes denominations on every cross-currency settlement and leaves
 * false remainders on the consumed (from) line. One expression, every
 * reader: the live lateral below and the as-of open-item queries (web cash,
 * the cash agent) all build their applied sums from this, so the leg split
 * cannot drift apart again.
 *
 * @param appAlias the SQL alias of the `applications` row (a static
 * identifier from the calling query, never user input).
 * @param lineId the open-item line whose consumption is measured.
 * @param denomination "base" for the carrying columns, "transaction" for the
 * document-currency legs.
 */
export function appliedLegAmountExpr(
  appAlias: string,
  lineId: SQL,
  denomination: "base" | "transaction",
): SQL {
  const a = sql.raw(appAlias);
  const toCol = sql.raw(denomination === "base" ? "amount" : "target_transaction_amount");
  const fromCol = sql.raw(denomination === "base" ? "source_amount" : "source_transaction_amount");
  return sql`case when ${a}.from_line_id = ${lineId} then ${a}.${fromCol} else ${a}.${toCol} end`;
}

/**
 * The live "what is still due on this document" applied-amount subquery, in
 * both denominations the callers need. Every surface that names a document
 * balance — the generic drawer (`web/lib/documents.ts`), record PDFs and
 * email (`web/lib/pdf-templates/values.ts`), the dunning scan below — joins
 * this lateral and computes `documents.total - applied`. One formula, one
 * place: the drawer figure, the figure printed on the customer's PDF, and
 * the figure dunning acts on cannot drift apart again.
 *
 * Two hard-won rules are structural here, not comments:
 *
 * 1. Denomination. `documents.total` is in the document's TRANSACTION
 *    currency while `applications.amount` is the base-currency carrying
 *    amount. The applied sum therefore reads the transaction legs
 *    (`target_transaction_amount` / `source_transaction_amount`), never the
 *    base legs — subtracting base from total printed a balance in neither
 *    currency on every FX invoice, on paper and in dunning mail. The base
 *    legs (`amount` / `source_amount`) are exposed separately as
 *    `applied_base` for the dunning threshold compare only: the policy
 *    minimum is a bare number that can only mean base currency.
 *
 * 2. Legs. An application consumes its target line (to_line_id) AND its
 *    source line (from_line_id): a credit memo applied to an invoice settles
 *    the invoice through the to-leg and is itself consumed through the
 *    from-leg. Each leg consumes its own carrying columns — the to-leg reads
 *    `amount` / `target_transaction_amount`, the from-leg reads
 *    `source_amount` / `source_transaction_amount` — exactly the caps the
 *    `app_check_open` trigger enforces and the split the maintained
 *    `document_open_balance_amount` cache computes. A to-leg-only reader
 *    reports a consumed credit as still open on the drawer and the PDF while
 *    the aging (which nets both legs) shows it settled.
 *
 * Scope: the LIVE balance — applications with `unapplied_at` set are
 * excluded and there is no as-of cutoff (as-of readers such as the aging
 * reconstruct history and must keep their own date-gated queries). Only the
 * document's posted entry contributes, and only its open-item lines. Callers
 * keep their own posted/voided gating (`balance_due` stays NULL until the
 * document posts); this lateral just reports the applied sums.
 *
 * @param docAlias the SQL alias of the outer `documents` row (a static
 * identifier from the calling query, never user input).
 * @param opts.base also select `applied_base` (base-currency carrying
 * amounts). The drawer/PDF callers omit it so their row shape is unchanged;
 * dunning needs it for the threshold compare.
 */
export function documentBalanceDueLateral(docAlias = "d", opts?: { base?: boolean }): SQL {
  const d = sql.raw(docAlias);
  return sql`
    left join lateral (
      select coalesce(sum(${appliedLegAmountExpr("a", sql`jl.id`, "transaction")}), 0) as applied
        ${opts?.base
          ? sql`, coalesce(sum(${appliedLegAmountExpr("a", sql`jl.id`, "base")}), 0) as applied_base`
          : sql``}
        from journal_lines jl
        join applications a on a.org_id = jl.org_id and (a.to_line_id = jl.id or a.from_line_id = jl.id) and a.unapplied_at is null
       where jl.org_id = ${d}.org_id and jl.entry_id = ${d}.posted_entry_id and jl.is_open_item
    ) ap on true`;
}
