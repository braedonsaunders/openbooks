import { isUuid } from "../platform/uuid.ts";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { PaymentError } from "./payment-errors.ts";

export interface CanadianChequeBank {
  bankName: string;
  branchAddress: string;
  institution: string;
  transit: string;
  accountEncoding: string;
  effectiveFrom: string;
}

/** Account separators come from the bank's cheque specification, not EFT routing. */
export function validateChequeBank(value: Record<string, unknown>): CanadianChequeBank {
  const text = (key: string, max: number) => {
    const v = value[key];
    if (typeof v !== "string" || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v))
      throw new PaymentError(`Configure cheque ${key} in the payment bank profile`);
    return v.trim();
  };
  const bankName = text("bankName", 100),
    branchAddress = text("branchAddress", 200);
  const institution = text("institution", 3),
    transit = text("transit", 5);
  const accountEncoding = text("accountEncoding", 17),
    effectiveFrom = text("effectiveFrom", 10);
  if (!/^\d{3}$/.test(institution) || !/^\d{5}$/.test(transit))
    throw new PaymentError("Cheque institution and transit require exactly three and five digits");
  if (!/^[0-9]+(?:[ -][0-9]+)*$/.test(accountEncoding))
    throw new PaymentError(
      "Use the account digits, spaces and dashes on the bank’s cheque specification",
    );
  if (!isIsoCalendarDate(effectiveFrom))
    throw new PaymentError("Cheque bank effective date must be a valid ISO date");
  return { bankName, branchAddress, institution, transit, accountEncoding, effectiveFrom };
}

export async function lockChequeBank(
  tx: SqlExecutor,
  orgId: string,
  profileId: string,
  subsidiaryId: string | null,
  currency: string,
  payDate: string,
) {
  if (!isUuid(profileId)) throw new PaymentError("Select a valid cheque bank profile");
  const row = (
    await tx.execute<{ sealed: string | null; bank_account_id: string; country: string | null }>(
      sql`
    select p.originator_secrets_encrypted sealed, p.bank_account_id,p.country from payment_bank_profiles p
    join payment_formats f on f.org_id=p.org_id and f.id=p.payment_format_id and f.is_active and f.rail='cheque'
    join accounts a on a.org_id=p.org_id and a.id=p.bank_account_id and a.is_active and not a.is_summary and a.type='asset_bank'
    where p.org_id=${orgId} and p.id=${profileId} and p.is_active and p.currency=${currency}
      and (p.subsidiary_id is null or p.subsidiary_id is not distinct from ${subsidiaryId}::uuid)
      and (a.subsidiary_id is null or a.subsidiary_id is not distinct from ${subsidiaryId}::uuid)
    for share of p,f,a
  `,
      "objects",
    )
  )[0];
  if (!row)
    throw new PaymentError(
      "Select an active cheque bank profile matching this payroll entity and currency in Payment Operations Setup",
    );
  const secrets = row.sealed
    ? unsealJson<Record<string, unknown>>(row.sealed, {
        orgId,
        purpose: "payment.originator.secrets",
      })
    : {};
  const bank = ["bankName", "branchAddress", "accountEncoding", "effectiveFrom"].some(
    (key) => secrets[key] !== undefined,
  )
    ? validateChequeBank(secrets)
    : null;
  if (bank && (row.country !== "CA" || currency !== "CAD"))
    throw new PaymentError(
      "Use preprinted bank stock for this cheque profile; printed Canadian MICR requires CAD and CA",
    );
  if (bank && bank.effectiveFrom > payDate)
    throw new PaymentError(
      "The cheque bank profile takes effect after this payment date; use its applicable bank stock",
    );
  return { profileId, bankAccountId: row.bank_account_id, bank };
}

export function chequeMicrFields(number: string, bank: CanadianChequeBank) {
  if (!/^\d{1,11}$/.test(number))
    throw new PaymentError(
      "Printed MICR requires a numeric cheque number of at most eleven digits; configure the payroll_cheque sequence before issuing new stock",
    );
  return {
    micrSerial: `⑈${number}⑈`,
    micrTransit: `⑆${bank.transit}⑉${bank.institution}⑆`,
    micrAccount: `⑈${bank.accountEncoding.replaceAll("-", "⑉")}`,
  };
}
