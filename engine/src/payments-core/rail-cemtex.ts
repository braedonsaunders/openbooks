import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { parseIsoDate } from "../platform/business-date.ts";
import { unsealJson } from "../platform/secrets.ts";
import { PaymentError } from "./payment-errors.ts";

// ---------------------------------------------------------------------------
// Cemtex (Australian ABA) originator settings
// ---------------------------------------------------------------------------

/**
 * The name is `cemtex`, never `aba`, on purpose. `ABA` already means the US
 * 9-digit routing number (American Bankers Association) throughout this
 * module and its neighbours (`odfiRouting`, the NACHA check digit) — a
 * format keyed `aba` would read as the US routing concept to every future
 * reader. Cemtex is the Australian file format's own name (the .aba
 * extension stays, because that is what the banks' upload screens ask for).
 */
export interface CemtexSettings {
  /** 3-letter APCA financial-institution abbreviation of the processing bank (CBA, NAB, ANZ, WBC, BQL, …). */
  bankAbbreviation: string;
  /** Name of the user supplying the file (26 chars; what the bank shows). */
  userName: string;
  /** APCA-allocated Direct Entry user ID (BECS User Identification Number, ≤6 digits). */
  userId: string;
  /** Source (trace) account BSB, NNN-NNN — the account the debit draws. */
  traceBsb: string;
  /** Source (trace) account number, ≤9 chars — the account the debit draws. */
  traceAccount: string;
  /** Name of the remitter as it appears on employee statements (16 chars). */
  remitterName: string;
}

/**
 * Australian BSB, canonical `NNN-NNN` form.
 *
 * Positions carry meaning (first two digits: financial institution, third:
 * state 0–9), but this validates SHAPE only — the directory of allocated
 * BSBs is not transcribed here, so an unallocated-but-shaped BSB passes and
 * the bank refuses it. The hyphen is pure formatting: six digits with an
 * optional hyphen or space canonicalize to `NNN-NNN`; anything else is not a
 * BSB and is refused rather than coerced (a coerced BSB pays a stranger).
 */
export function normalizeBsb(value: string): string | null {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function isValidBsb(value: string): boolean {
  return normalizeBsb(value) !== null;
}

/**
 * An Australian account number as the Cemtex detail record carries it:
 * numeric with hyphens/blanks only, right-justified blank-filled to 9.
 * Longer than nine characters even with hyphens edited out cannot be
 * expressed — refused, never truncated (truncation pays a stranger).
 */
export function normalizeCemtexAccount(value: string): string | null {
  const stripped = value.replace(/[-\s]/g, "");
  if (stripped === "" || stripped.length > 9 || !/^\d+$/.test(stripped)) return null;
  if (/^0+$/.test(stripped)) return null;
  return stripped;
}

const CEMTEX_REQUIRED: (keyof CemtexSettings)[] = [
  "bankAbbreviation", "userName", "userId", "traceBsb", "traceAccount", "remitterName",
];

export function validateCemtexSettings(raw: Partial<CemtexSettings> | null): { ok: true; settings: CemtexSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing: string[] = CEMTEX_REQUIRED.filter((k) => {
    const v = s[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (!missing.includes("bankAbbreviation") && !/^[A-Za-z]{3}$/.test(s.bankAbbreviation!)) {
    missing.push("bankAbbreviation (3-letter APCA abbreviation, e.g. CBA, ANZ, WBC)");
  }
  if (!missing.includes("userName") && s.userName!.length > 26) {
    missing.push("userName (max 26 characters)");
  }
  if (!missing.includes("userId") && !/^\d{1,6}$/.test(s.userId!.trim())) {
    missing.push("userId (APCA-allocated Direct Entry user ID, up to 6 digits)");
  }
  if (!missing.includes("traceBsb") && !isValidBsb(s.traceBsb!)) {
    missing.push("traceBsb (6-digit BSB, NNN-NNN)");
  }
  if (!missing.includes("traceAccount") && normalizeCemtexAccount(s.traceAccount!) === null) {
    missing.push("traceAccount (1–9 digits)");
  }
  if (!missing.includes("remitterName") && (s.remitterName!.trim() === "" || s.remitterName!.length > 16)) {
    missing.push("remitterName (1–16 characters, shown on employee statements)");
  }
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    settings: {
      bankAbbreviation: s.bankAbbreviation!.trim().toUpperCase(),
      userName: s.userName!.trim(),
      userId: s.userId!.trim(),
      traceBsb: normalizeBsb(s.traceBsb!)!,
      traceAccount: normalizeCemtexAccount(s.traceAccount!)!,
      remitterName: s.remitterName!.trim(),
    },
  };
}

export async function loadCemtexSettings(orgId: string, runId?: string) {
  const r = (await db.execute<{ originator_secrets_encrypted: string | null }>(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
      left join payment_runs r on r.payment_bank_profile_id = p.id and r.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.rail = 'cemtex_credit'
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `));
  return validateCemtexSettings(unsealJson<Partial<CemtexSettings>>(r.rows[0]?.originator_secrets_encrypted));
}

export interface CemtexPayment {
  /** Amount in cents (positive integer, max 10 digits). */
  amountCents: bigint;
  /** Target account BSB, canonical NNN-NNN. */
  bsb: string;
  /** Target account number, 1–9 digits (hyphens already edited out). */
  accountNumber: string;
  /** Title of the account to be credited (≤32 chars). */
  accountTitle: string;
  /** Lodgement reference on the employee's statement (≤18 chars). */
  lodgementReference: string;
}

export interface CemtexRun {
  settings: CemtexSettings;
  /**
   * Date the transactions are released to all financial institutions, as an
   * explicit civil day (YYYY-MM-DD) in the org's business time zone — a
   * string, never an instant, so the release-date bytes cannot shift with
   * the server's local zone.
   */
  processingDate: string;
  /** Detail payments — all credits (transaction code 53, Pay). */
  payments: CemtexPayment[];
}

/**
 * Build an Australian Cemtex (ABA) direct-credit file: descriptive record
 * (type 0), one detail record (type 1) per payment, file-total record
 * (type 7); every record exactly 120 characters, joined with CRLF.
 *
 * Offsets verified position for position against three concordant published
 * transcriptions, which agree with each other on every field boundary:
 *
 * - Cemtex, "ABA file format technical details" (cemtexaba.com, retrieved
 *   2026-09-20) — the format owner's own field tables for records 0, 1 and 7.
 * - M. Cordover, sample-with-comments.aba v1.1 (2013-04-07, CC-BY 3.0 AU) —
 *   an annotated 3-line file with a character ruler, which additionally names
 *   the formal specification: the file type is formally a BECS DE (Bulk
 *   Electronic Clearing System Direct Entry) file specified by the Australian
 *   Payments Clearing Association in Appendix C2 (pp. 78–85) with the
 *   character set in Appendix C7 (p. 86) of the BECS Procedures. That APCA
 *   PDF is no longer reachable (APCA became AusPayNet in 2017), so the
 *   offsets below are the triple-corroborated transcription, not a reading
 *   of the formal pages.
 * - flash-oss aba-generator 2.1.0 (npm) — its record schemas carry the same
 *   boundaries in 0-indexed form (header bsb [1,8], account [8,17], seq
 *   [18,20], bank [20,23], user [30,56], userId [56,62], description [62,74],
 *   date [74,80], time [80,84]; detail bsb [1,8], account [8,17], indicator
 *   [17,18], code [18,20], amount [20,30], title [30,62], reference [62,80],
 *   traceBsb [80,87], traceAccount [87,96], remitter [96,112], withholding
 *   [112,120]; total net [20,30], credit [30,40], debit [40,50], count
 *   [74,80]).
 *
 * Where the transcriptions differ in PROSE they are reconciled toward the
 * formal APCA shape: the descriptive record carries the funds-account Ext:BSB
 * (2–8) and Ext:Account (9–17) plus the processing-time field (81–84, left
 * blank — the APCA specification requires blank; some banks accept HHmm).
 * Where a transcription's prose disagrees with its own BYTES, the bytes win:
 * the Cordover sample's comment credits "BSB 062-292" but its detail record
 * carries "062-692" at positions 2–8.
 *
 * Payroll fixes what BECS standardizes rather than what an institution
 * assigns: transaction code 53 (Pay), blank indicator, zero withholding (PAYG
 * withholding is remitted to the ATO through its own channel, never through
 * the withholding-tax field), description "PAYROLL", reel sequence "01".
 */
export function buildCemtexFile(run: CemtexRun): string {
  const checked = validateCemtexSettings(run.settings);
  if (!checked.ok) {
    throw new PaymentError(`Cemtex originator settings are invalid: ${checked.missing.join(", ")}`);
  }
  const s = checked.settings;
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");
  // The annotated sample caps a file at 500 detail records ("though that
  // limit may be increased by certain financial institutions"). The reel
  // sequence number exists for multi-file batches, which this writer does not
  // produce — so a population past the cap is a named refusal, never a
  // silently over-long file the bank rejects.
  if (run.payments.length > 500) {
    throw new PaymentError(
      `Cemtex file holds at most 500 detail records but the run has ${run.payments.length} — split the pay run or arrange a higher file limit with the bank`,
    );
  }

  const padR = (value: string, len: number): string => {
    if (value.length > len) throw new PaymentError(`field value "${value}" does not fit in ${len} characters`);
    return value.padEnd(len, " ");
  };
  const padL0 = (value: string, len: number): string => {
    if (value.length > len || !/^\d*$/.test(value)) {
      throw new PaymentError(`numeric field value "${value}" does not fit in ${len} digits`);
    }
    return value.padStart(len, "0");
  };
  const bsb = (value: string, what: string): string => {
    const normal = normalizeBsb(value);
    if (!normal) throw new PaymentError(`${what} "${value}" is not a 6-digit BSB (NNN-NNN)`);
    return normal;
  };
  const account = (value: string, what: string): string => {
    const normal = normalizeCemtexAccount(value);
    if (normal === null) {
      throw new PaymentError(`${what} "${value}" must be 1–9 digits (hyphens edited out), not blank and not all zeros`);
    }
    return normal.padStart(9, " ");
  };
  // Release date DDMMYY from an already-zoned civil day (YYYY-MM-DD): UTC
  // accessors on the parsed date read the same parts on every host. Local
  // getDate/getMonth/getFullYear here would reintroduce server-zone bytes.
  const ddmmyy = (iso: string): string => {
    let day: string;
    let month: string;
    let year: string;
    try {
      const parsed = parseIsoDate(iso);
      const p = (n: number) => String(n).padStart(2, "0");
      day = p(parsed.getUTCDate());
      month = p(parsed.getUTCMonth() + 1);
      year = p(parsed.getUTCFullYear() % 100);
    } catch {
      throw new PaymentError(`Cemtex release date "${iso}" is not a valid YYYY-MM-DD civil day`);
    }
    return `${day}${month}${year}`;
  };

  // -- 0: descriptive ---------------------------------------------------
  // Positions 2–17 carry the funds (source) account. The APCA text calls
  // them Ext:BSB/Ext:Account and requires blank, but every bank-facing
  // transcription populates them: the annotated sample's own bytes carry
  // the funds account there, and aba-generator marks the header BSB
  // "required by most banks". The bytes win — the trace account goes here
  // as well as on every detail record. Computed first so both records share
  // the one validated value.
  const traceBsb = bsb(s.traceBsb, "trace BSB");
  const traceAccount = account(s.traceAccount, "trace account");
  const descriptive =
    "0" +
    traceBsb + // 2–8: funds-account BSB
    traceAccount + // 9–17: funds-account number (right-justified, blank-filled)
    " " + // 18: reserved, blank
    "01" + // 19–20: reel sequence number (single-file batch)
    s.bankAbbreviation + // 21–23: processing bank's APCA abbreviation
    padR("", 7) + // 24–30: reserved, blank
    padR(s.userName, 26) + // 31–56: user preferred name
    padL0(s.userId, 6) + // 57–62: BECS User Identification Number
    padR("PAYROLL", 12) + // 63–74: file description — this file IS a payroll file
    ddmmyy(run.processingDate) + // 75–80: release date DDMMYY
    padR("", 4) + // 81–84: processing time — blank, as the APCA specification requires
    padR("", 36); // 85–120: reserved, blank
  if (descriptive.length !== 120) throw new PaymentError("internal error: Cemtex descriptive record is not 120 characters");

  // -- 1: details ---------------------------------------------------------
  const details = run.payments.map((p) => {
    if (p.amountCents <= 0n) throw new PaymentError("payment amounts must be positive");
    const record =
      "1" +
      bsb(p.bsb, "target BSB") + // 2–8
      account(p.accountNumber, "target account") + // 9–17
      " " + // 18: indicator — blank (no new/varied details, no dividend/interest withholding)
      "53" + // 19–20: transaction code 53, Pay
      padL0(String(p.amountCents), 10) + // 21–30: cents, unsigned zero-filled
      padR(p.accountTitle, 32) + // 31–62
      padR(p.lodgementReference, 18) + // 63–80
      traceBsb + // 81–87
      traceAccount + // 88–96
      padR(s.remitterName, 16) + // 97–112
      padL0("0", 8); // 113–120: withholding tax — zero (PAYG goes to the ATO, not here)
    if (record.length !== 120) throw new PaymentError("internal error: Cemtex detail record is not 120 characters");
    return record;
  });

  // -- 7: file total ------------------------------------------------------
  const total = run.payments.reduce((acc, p) => acc + p.amountCents, 0n);
  const trailer =
    "7" +
    "999-999" + // 2–8: BSB-format filler
    padR("", 12) + // 9–20: reserved, blank
    padL0(String(total), 10) + // 21–30: net (credits minus debits; payroll files carry no debits)
    padL0(String(total), 10) + // 31–40: credit total
    padL0("0", 10) + // 41–50: debit total — nil on a payroll credit file
    padR("", 24) + // 51–74: reserved, blank
    padL0(String(run.payments.length), 6) + // 75–80: detail-record count
    padR("", 40); // 81–120: reserved, blank
  if (trailer.length !== 120) throw new PaymentError("internal error: Cemtex file-total record is not 120 characters");

  return [descriptive, ...details, trailer].join("\r\n") + "\r\n";
}
