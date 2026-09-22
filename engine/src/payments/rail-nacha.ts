import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { formatInZone, formatTimeInZone } from "../platform/business-date.ts";
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

/**
 * Unsigned numeric field that refuses overflow instead of truncating.
 * nachaField truncates text to its width (the spec pads those), but a money
 * amount or total that does not fit must never silently lose its leading
 * digits — slice(0, 10) on an 11-digit amount drops the ONES, not the top.
 */
function nachaNumeric(v: string, len: number, field: string): string {
  if (!/^\d+$/.test(v)) throw new PaymentError(`NACHA ${field} must be numeric`);
  if (v.length > len) {
    throw new PaymentError(
      `NACHA ${field} of ${v.length} digits does not fit its ${len}-digit field — refusing to truncate`,
    );
  }
  return v.padStart(len, "0");
}

/**
 * File ID modifier alphabet shared with payroll (bank-file-artifact.ts):
 * one derivation, not two. Consecutive files advance A→B→…→Z→0→…→9 and wrap;
 * the header's creation date disambiguates across days, and a second file to
 * the same bank the same day is exactly what the next letter is for.
 */
export const NACHA_FILE_ID_MODIFIERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function nachaFileIdModifierForSequence(sequenceValue: number): string {
  if (!Number.isSafeInteger(sequenceValue) || sequenceValue < 1) {
    throw new PaymentError("NACHA file ID modifier requires a positive sequence value");
  }
  return NACHA_FILE_ID_MODIFIERS[(sequenceValue - 1) % NACHA_FILE_ID_MODIFIERS.length]!;
}

/**
 * Derive an AP run file's modifier from its run number — the same
 * sequence-derivation payroll uses for its artifact numbers, so two runs
 * never share a modifier and re-downloading one run reproduces its bytes.
 */
export function nachaFileIdModifierForRunNumber(runNumber: string): string {
  const sequenceValue = Number(runNumber.replace(/\D/g, "") || "1");
  if (!Number.isSafeInteger(sequenceValue) || sequenceValue < 1) {
    throw new PaymentError(
      `payment run number "${runNumber}" cannot allocate a NACHA file ID modifier`,
    );
  }
  return nachaFileIdModifierForSequence(sequenceValue);
}

/** Build a NACHA ACH credit file (94-char records, blocked to 10). */
export function buildNachaFile(opts: {
  settings: NachaSettings;
  effectiveDate: Date;
  creationDate: Date;
  fileIdModifier?: string;
  /**
   * IANA zone the CREATION stamp renders in (the org's zone, resolved by the
   * caller). Without it the stamp reads the server's local clock — the same
   * instant renders different headers on servers in different zones, which
   * defeats byte-identical re-downloads and the bank's duplicate detection.
   * The effective date is a zone-free calendar day and always renders as-is.
   */
  timeZone?: string;
  entries: NachaEntry[];
}): string {
  const s = opts.settings;
  if (opts.entries.length === 0) throw new PaymentError("run has no payments to export");
  // The modifier is the bank's same-day duplicate-file key: a silent default
  // would hand every file the same identity. Every caller allocates one
  // explicitly (payroll from its artifact sequence, AP from its run number —
  // both through nachaFileIdModifierForSequence above).
  const modifier = opts.fileIdModifier ?? "";
  if (!/^[A-Z0-9]$/.test(modifier)) {
    throw new PaymentError("NACHA file requires an allocated file ID modifier (single character A–Z, 0–9)");
  }
  const sec = s.entryClassCode ?? "CCD";
  const odfi8 = s.odfiRouting.slice(0, 8);
  const yymmdd = (d: Date) => `${String(d.getFullYear() % 100).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

  // The creation stamp is an instant, so it renders in the caller's explicit
  // zone; the server's local clock must never leak into bank bytes.
  let creationYymmdd = yymmdd(opts.creationDate);
  let creationHhmm = hhmm(opts.creationDate);
  if (opts.timeZone != null) {
    try {
      const zonedDay = formatInZone(opts.creationDate, opts.timeZone);
      creationYymmdd = zonedDay.slice(2, 4) + zonedDay.slice(5, 7) + zonedDay.slice(8, 10);
      creationHhmm = formatTimeInZone(opts.creationDate, opts.timeZone);
    } catch {
      throw new PaymentError(`NACHA creation time zone "${opts.timeZone}" is not a valid IANA time zone`);
    }
  }

  const rows: string[] = [];
  // 1 — File Header
  rows.push(
    "1" + "01" + nachaField(s.immediateDestination, 10, "r") + nachaField(s.immediateOrigin, 10, "r") +
    creationYymmdd + creationHhmm + modifier + "094" + "10" + "1" +
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
      "6" + e.transactionCode + rt8 + checkDigit + nachaField(e.accountNumber, 17) + nachaNumeric(String(e.amountCents), 10, "payment amount") +
      nachaField(e.individualId, 15) + nachaField(e.individualName, 22) + nachaField("", 2) + "0" + trace,
    );
  });
  const hashMod = nachaNumeric((entryHash % 10_000_000_000n).toString(), 10, "entry hash");
  // 8 — Batch Control
  rows.push(
    "8" + "220" + nachaNumeric(String(opts.entries.length), 6, "entry count") + hashMod +
    nachaNumeric("0", 12, "debit total") + nachaNumeric(String(totalCredit), 12, "credit total") + nachaField(s.companyId, 10) +
    nachaField("", 19) + nachaField("", 6) + odfi8 + nachaField("0000001", 7, "r", "0"),
  );
  // 9 — File Control
  const entryCount = opts.entries.length;
  const blockCount = Math.ceil((rows.length + 1) / 10);
  rows.push(
    "9" + nachaNumeric("1", 6, "batch count") + nachaNumeric(String(blockCount), 6, "block count") + nachaNumeric(String(entryCount), 8, "entry count") +
    hashMod + nachaNumeric("0", 12, "debit total") + nachaNumeric(String(totalCredit), 12, "credit total") + nachaField("", 39),
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
