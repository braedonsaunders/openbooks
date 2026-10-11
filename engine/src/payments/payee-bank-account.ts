import { sql, type SQL } from "drizzle-orm";

/**
 * SQL form of the payee bank-account eligibility defined by
 * classifyPayeeBankAccount (payments/payment-contracts): approved status with
 * its approval date, active, and not retired. Run creation, the run builder's
 * bank-details column, and the mandate bank selectors all read these
 * fragments, so every screen and writer agrees on which account is payable.
 */

/**
 * SQL predicate for an account a payment run may pay into. `alias` is a
 * code-owned table alias, never request input.
 */
export function payablePayeeBankAccountSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`${a}.is_active and ${a}.approval_status = 'approved' and ${a}.approved_at is not null and ${a}.retired_at is null`;
}

/**
 * Per-payee bank state as a SQL expression evaluating to one of the
 * PayeeBankState values. A payable account wins over a pending one, which
 * wins over an undated approval, so the screen names the most actionable
 * state. `partyId` and `orgId` are SQL expressions naming the payee and
 * tenant columns of the enclosing query.
 */
export function payeeBankStateSql(partyId: SQL, orgId: SQL): SQL {
  const scoped = (predicate: SQL) => sql`exists (
      select 1 from party_bank_accounts b
       where b.party_id = ${partyId} and b.org_id = ${orgId} and ${predicate}
    )`;
  return sql`case
    when ${scoped(payablePayeeBankAccountSql("b"))} then 'approved'
    when ${scoped(sql`b.retired_at is null and b.approval_status = 'pending'`)} then 'pending'
    when ${scoped(sql`b.retired_at is null and b.approval_status = 'approved' and b.approved_at is null`)} then 'undated'
    else 'missing'
  end`;
}
