import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { PaymentError } from "./payment-errors.ts";
import { validateRbcStd152Settings, type RbcStd152Settings } from "./rail-rbc-std152.ts";

export async function loadRbcStd152Settings(orgId: string, runId: string) {
  const row = (
    await db.execute<{ sealed: string | null; currency: string }>(
      sql`
    select p.originator_secrets_encrypted as sealed, p.currency from payment_runs r
    join payment_bank_profiles p on p.org_id=r.org_id and p.id=r.payment_bank_profile_id and p.is_active
    join payment_formats f on f.org_id=p.org_id and f.id=p.payment_format_id and f.is_active
    where r.org_id=${orgId} and r.id=${runId} and f.rail='rbc_std152_credit'
  `,
      "objects",
    )
  )[0];
  if (row?.currency !== "CAD")
    return {
      ok: false as const,
      missing: ["the available RBC STD152 format requires a CAD profile"],
    };
  const checked = validateRbcStd152Settings(
    row?.sealed
      ? unsealJson<Partial<RbcStd152Settings>>(row.sealed, {
          orgId,
          purpose: "payment.originator.secrets",
        })
      : {},
  );
  if (checked.ok && checked.settings.serviceCurrency !== "CAD")
    return {
      ok: false as const,
      missing: ["the available RBC STD152 format requires a CAD service"],
    };
  return checked;
}

export function rbcStd152SettingsDigest(settings: RbcStd152Settings): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.clientNumber,
        settings.originatorLongName,
        settings.originatorShortName,
        settings.transactionCode,
        settings.serviceCurrency,
        settings.transmission,
        settings.environment,
      ]),
    )
    .digest("hex");
}

/** One bank-facing number space for AP and payroll sharing an RBC client. */
export async function allocateRbcStd152Number(
  tx: SqlExecutor,
  orgId: string,
  clientNumber: string,
): Promise<number> {
  if (!/^\d{10}$/.test(clientNumber))
    throw new PaymentError("RBC file number allocation requires a valid client number");
  const kind = "rbc_std152:" + createHash("sha256").update(clientNumber).digest("hex");
  const row = (
    await tx.execute<{ next_number: number }>(
      sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId},${kind},null,'RBC-')
    on conflict on constraint sequences_org_kind_sub
    do update set next_number=number_sequences.next_number+1
      where number_sequences.org_id=${orgId} and number_sequences.next_number<9999
    returning next_number
  `,
      "objects",
    )
  )[0];
  if (
    !row ||
    !Number.isInteger(Number(row.next_number)) ||
    Number(row.next_number) < 1 ||
    Number(row.next_number) > 9999
  ) {
    throw new PaymentError(
      "RBC file creation numbers are exhausted — arrange a renewed file-number range with RBC before changing the numbering sequence; numbers are never silently reused",
    );
  }
  return Number(row.next_number);
}
