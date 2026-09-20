import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { PaymentError } from "./payment-errors.ts";

export interface NachaSettings {
  /** ODFI 9-digit routing/ABA number (the originating bank). */
  odfiRouting: string;
  /** 10-char immediate destination (usually " " + destination routing 9). */
  immediateDestination: string;
  /** 10-char immediate origin (usually company id / " " + routing 9). */
  immediateOrigin: string;
  destinationName: string;
  originName: string;
  /** Company name on the batch (≤16). */
  companyName: string;
  /** Company id (10) — commonly "1" + 9-digit EIN. */
  companyId: string;
  /** PPD (consumer) or CCD (corporate). Default CCD. */
  entryClassCode?: "PPD" | "CCD";
  /** Batch entry description (≤10). Default "PAYMENT". */
  entryDescription?: string;
}

const NACHA_REQUIRED: (keyof NachaSettings)[] = [
  "odfiRouting", "immediateDestination", "immediateOrigin", "destinationName", "originName", "companyName", "companyId",
];

export function validateNachaSettings(raw: Partial<NachaSettings> | null): { ok: true; settings: NachaSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing = NACHA_REQUIRED.filter((k) => {
    const v = s[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (missing.length) return { ok: false, missing };
  if (!/^\d{9}$/.test(s.odfiRouting!)) return { ok: false, missing: ["odfiRouting (9 digits)"] };
  return { ok: true, settings: s as NachaSettings };
}

export async function loadNachaSettings(orgId: string, runId?: string) {
  const r = (await db.execute<{ originator_secrets_encrypted: string | null }>(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
      left join payment_runs r on r.payment_bank_profile_id = p.id and r.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.rail in ('nacha_credit', 'nacha_debit')
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `));
  return validateNachaSettings(unsealJson<Partial<NachaSettings>>(r.rows[0]?.originator_secrets_encrypted));
}

export interface NachaEntry {
  /** 22 = checking credit, 32 = savings credit. */
  transactionCode: "22" | "32";
  /** Receiving bank 9-digit routing (8 + check digit). */
  routingNumber: string;
  accountNumber: string;
  amountCents: bigint;
  individualId: string;
  individualName: string;
}

function nachaField(v: string, len: number, align: "l" | "r" = "l", pad = " "): string {
  const s = v.slice(0, len);
  return align === "l" ? s.padEnd(len, pad) : s.padStart(len, pad);
}

/** Build a NACHA ACH credit file (94-char records, blocked to 10). */
export function buildNachaFile(opts: {
  settings: NachaSettings;
  effectiveDate: Date;
  creationDate: Date;
  fileIdModifier?: string;
  entries: NachaEntry[];
}): string {
  const s = opts.settings;
  if (opts.entries.length === 0) throw new PaymentError("run has no payments to export");
  const sec = s.entryClassCode ?? "CCD";
  const odfi8 = s.odfiRouting.slice(0, 8);
  const yymmdd = (d: Date) => `${String(d.getFullYear() % 100).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

  const rows: string[] = [];
  // 1 — File Header
  rows.push(
    "1" + "01" + nachaField(s.immediateDestination, 10, "r") + nachaField(s.immediateOrigin, 10, "r") +
    yymmdd(opts.creationDate) + hhmm(opts.creationDate) + (opts.fileIdModifier ?? "A") + "094" + "10" + "1" +
    nachaField(s.destinationName, 23) + nachaField(s.originName, 23) + nachaField("", 8),
  );
  // 5 — Batch Header (220 = credits only)
  rows.push(
    "5" + "220" + nachaField(s.companyName, 16) + nachaField("", 20) + nachaField(s.companyId, 10) + sec +
    nachaField(s.entryDescription ?? "PAYMENT", 10) + nachaField("", 6) + yymmdd(opts.effectiveDate) + nachaField("", 3) +
    "1" + odfi8 + nachaField("0000001", 7, "r", "0"),
  );
  // 6 — Entry Details
  let entryHash = 0n;
  let totalCredit = 0n;
  opts.entries.forEach((e, i) => {
    if (e.amountCents <= 0n) throw new PaymentError("payment amounts must be positive");
    if (e.accountNumber.trim() === "") throw new PaymentError("payment account number must not be blank");
    if (e.accountNumber.length > 17) throw new PaymentError("payment account number must be 17 characters or fewer");
    if (!/^\d{8,9}$/.test(e.routingNumber)) {
      throw new PaymentError("payment routing number must contain eight or nine digits");
    }
    const rt8 = e.routingNumber.slice(0, 8);
    const expectedCheckDigit = nachaCheckDigit(rt8);
    if (e.routingNumber.length === 9 && e.routingNumber[8] !== expectedCheckDigit) {
      throw new PaymentError("payment routing number has an invalid ABA check digit");
    }
    const checkDigit = e.routingNumber.length === 9 ? e.routingNumber[8] : expectedCheckDigit;
    entryHash += BigInt(rt8);
    totalCredit += e.amountCents;
    const trace = odfi8 + String(i + 1).padStart(7, "0");
    rows.push(
      "6" + e.transactionCode + rt8 + checkDigit + nachaField(e.accountNumber, 17) + nachaField(String(e.amountCents), 10, "r", "0") +
      nachaField(e.individualId, 15) + nachaField(e.individualName, 22) + nachaField("", 2) + "0" + trace,
    );
  });
  const hashMod = (entryHash % 10_000_000_000n).toString().padStart(10, "0");
  // 8 — Batch Control
  rows.push(
    "8" + "220" + nachaField(String(opts.entries.length), 6, "r", "0") + hashMod +
    nachaField("0", 12, "r", "0") + nachaField(String(totalCredit), 12, "r", "0") + nachaField(s.companyId, 10) +
    nachaField("", 19) + nachaField("", 6) + odfi8 + nachaField("0000001", 7, "r", "0"),
  );
  // 9 — File Control
  const entryCount = opts.entries.length;
  const blockCount = Math.ceil((rows.length + 1) / 10);
  rows.push(
    "9" + nachaField("1", 6, "r", "0") + nachaField(String(blockCount), 6, "r", "0") + nachaField(String(entryCount), 8, "r", "0") +
    hashMod + nachaField("0", 12, "r", "0") + nachaField(String(totalCredit), 12, "r", "0") + nachaField("", 39),
  );
  // pad with 9-filler records to a full 10-record block
  while (rows.length % 10 !== 0) rows.push("9".repeat(94));
  for (const r of rows) if (r.length !== 94) throw new PaymentError(`NACHA record is ${r.length} chars, not 94`);
  return rows.join("\n") + "\n";
}

/** ABA routing check digit (mod-10 weighted 3-7-1) from the first 8 digits. */
export function nachaCheckDigit(rt8: string): string {
  const w = [3, 7, 1, 3, 7, 1, 3, 7];
  const sum = rt8.split("").reduce((a, d, i) => a + Number(d) * w[i]!, 0);
  return String((10 - (sum % 10)) % 10);
}
