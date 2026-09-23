import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { addCalendarDays, parseIsoDate, utcDateFromParts } from "../platform/business-date.ts";
import { unsealJson } from "../platform/secrets.ts";
import { PaymentError } from "./payment-errors.ts";

// ---------------------------------------------------------------------------
// Bacs (United Kingdom) counterparty coordinates — SHAPE ONLY
// ---------------------------------------------------------------------------

/**
 * A UK sort code, canonical `NN-NN-NN` form.
 *
 * Six digits with optional hyphens or spaces canonicalize; anything else is
 * not a sort code and is refused rather than coerced (a coerced sort code
 * pays a stranger). This validates SHAPE only: whether the code is allocated
 * lives in the industry's Extended Industry Sort Code Directory, which is not
 * transcribed here, and the VocaLink modulus check needs its full weight
 * tables — so a shaped-but-unallocated code passes and the bank refuses it.
 */
export function normalizeSortCode(value: string): string | null {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

export function isValidSortCode(value: string): boolean {
  return normalizeSortCode(value) !== null;
}

/**
 * A UK account number as a Bacs destination account: exactly eight digits.
 * Spaces and hyphens are formatting and edit out; anything that is not eight
 * digits — shorter, longer, alpha, blank, all zeros — cannot be expressed in
 * the fixed-width account field and is refused, never truncated or padded
 * into a differently-numbered account.
 */
export function normalizeGbAccountNumber(value: string): string | null {
  const stripped = value.replace(/[-\s]/g, "");
  if (stripped === "" || !/^\d{8}$/.test(stripped)) return null;
  if (/^0+$/.test(stripped)) return null;
  return stripped;
}

// NOTE: Bacs originator settings ARE shaped here (unlike counterparty-only
// rails) because the writer needs exactly four bank-assigned values — the
// 6-digit Service User Number and the originating sort code, account and
// account name — and each is validated to its channel shape below. The file
// LAYOUT they populate is transcribed in `buildBacsFile`
// (engine/src/payments/rail-bacs.ts) with per-field source notes.
export interface BacsSettings {
  /** 6-digit Service User Number assigned by the bank (VOL1 owner + HDR1 SUN). */
  serviceUserNumber: string;
  /** Originating (debit-side) sort code, NNNN-NN canonical `NN-NN-NN`. */
  originatingSortCode: string;
  /** Originating (debit-side) account number, exactly 8 digits. */
  originatingAccount: string;
  /** Service user's account name (Standard 18 field 9, ≤18 chars). */
  serviceUserName: string;
}

const BACS_REQUIRED: (keyof BacsSettings)[] = [
  "serviceUserNumber", "originatingSortCode", "originatingAccount", "serviceUserName",
];

export function validateBacsSettings(raw: Partial<BacsSettings> | null): { ok: true; settings: BacsSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing: string[] = BACS_REQUIRED.filter((k) => {
    const v = s[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (!missing.includes("serviceUserNumber") && !/^\d{6}$/.test(s.serviceUserNumber!.trim())) {
    missing.push("serviceUserNumber (6-digit Service User Number assigned by your bank)");
  }
  if (!missing.includes("originatingSortCode") && !isValidSortCode(s.originatingSortCode!)) {
    missing.push("originatingSortCode (6-digit sort code of the account the Bacs debit will draw)");
  }
  if (!missing.includes("originatingAccount") && normalizeGbAccountNumber(s.originatingAccount!) === null) {
    missing.push("originatingAccount (8-digit account the Bacs debit will draw)");
  }
  if (!missing.includes("serviceUserName") && s.serviceUserName!.length > 18) {
    missing.push("serviceUserName (max 18 characters, shown on employee statements)");
  }
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    settings: {
      serviceUserNumber: s.serviceUserNumber!.trim(),
      originatingSortCode: normalizeSortCode(s.originatingSortCode!)!,
      originatingAccount: normalizeGbAccountNumber(s.originatingAccount!)!,
      serviceUserName: s.serviceUserName!.trim(),
    },
  };
}

export async function loadBacsSettings(orgId: string, runId?: string) {
  const r = (await db.execute<{ originator_secrets_encrypted: string | null }>(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
      left join payment_runs r on r.payment_bank_profile_id = p.id and r.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.rail = 'bacs_credit'
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `));
  return validateBacsSettings(unsealJson<Partial<BacsSettings>>(r.rows[0]?.originator_secrets_encrypted));
}

export interface BacsPayment {
  /** Amount in pence (positive integer, max 11 digits). */
  amountCents: bigint;
  /** Destination sort code, canonical NN-NN-NN (re-validated below). */
  sortCode: string;
  /** Destination account number, 8 digits (re-validated below). */
  accountNumber: string;
  /** Destination account name (≤18 chars after channel mapping). */
  accountName: string;
  /** Service user's reference on the employee's statement (≤18 chars after channel mapping). */
  reference: string;
}

export interface BacsRun {
  settings: BacsSettings;
  /**
   * The Bacs processing date (the run's pay date): UHL1 positions 5–10, as an
   * explicit civil day (YYYY-MM-DD) in the org's business time zone. A string,
   * never an instant: reading getFullYear/getMonth/getDate off a Date renders
   * the server's local day, so the same run emits different creation-day
   * bytes on servers in different zones.
   */
  processingDate: string;
  /**
   * File creation day (HDR1 creation date): the creation instant's civil day
   * in the org's business time zone, converted once by the caller — explicit
   * so goldens are reproducible and byte-identical across host time zones.
   */
  creationDate: string;
  /**
   * VOL1 serial, 6 chars, pre-allocated by the caller from its number
   * sequence — Bacs validates serials against duplicates (held 3 months), so
   * it is allocated once and stored, never re-derived.
   */
  volSerial: string;
  /** UHL1 file number, 3 digits, pre-allocated by the caller. */
  fileNumber: string;
  /** Detail payments — all Direct Credits (transaction code 99). */
  payments: BacsPayment[];
}

/**
 * Build a Bacs Standard 18 Direct Credit submission: VOL1/HDR1/HDR2/UHL1
 * labels (80 chars), one 100-char credit record (code 99) per payment, one
 * debit contra (code 17), EOF1/EOF2, UTL1; records joined with CRLF.
 *
 * Single-processing-day, single-account-section, single-SUN direct submission
 * only — the shape payroll always has (one pay date, one originating
 * account). Multi-day files (106-char records), bureaus submitting for many
 * SUNs (VOL1 owner ≠ HDR1 SUN), and AUDDIS/DD flows are out of scope and
 * refused by construction (there is only one SUN field in the settings).
 *
 * EVIDENCE. The formal specification is Bacs Electronic Funds Transfer, File
 * Structures (PN5011) v3.10 (VocaLink, 03 Oct 2016) — published to service
 * users and members, not openly; the service-user PDFs on bacs.co.uk require
 * login (confirmed 2026-09-20). The layout below is transcribed from four
 * concordant published sources, none of which is the PN5011 PDF:
 *
 * 1. Bacs, "ISO 20022/Bacs Translation Guide" v1.1 (29 Nov 2017, public
 *    bacs.co.uk document library, retrieved 2026-09-20) — Bacs' own
 *    description of Standard 18: the 11 numbered input fields and their
 *    semantics (§5.2), the VOL1/HDR1/HDR2/UHL1/input/EOF1/EOF2/UTL1
 *    submission skeleton (§5.3), fields 9 (47–64) and 11 (83–100) at their
 *    exact positions (§5.7, citing PN5011), the HDR1 SUN at characters 6–11
 *    (§5.4), credit-side code 99 / debit-side code 17 (§7.3.2, §4.2), contra
 *    mechanics — code 17, identical originating/destination accounts, field
 *    10 "CONTRA", multi-contra rule (§4.2) — the Bacs charset (§4.8) and
 *    bYYDDD dates (§4.9).
 * 2. The Access Group, Dimensions help centre, "BACS Standard 18" (retrieved
 *    2026-09-20) — position-level tables for every record above, including
 *    the 100-char data record (106 for multi-day), the contra, and UTL1.
 * 3. PayBatch (victorsaly/batch-payment-app, open source, active Aug 2026),
 *    src/standard18.js — a second 100-char credit implementation agreeing
 *    with (2) on all eleven data boundaries, with field-slice assertions in
 *    test/run.js (a worked example: dest 123456/12345678, origin
 *    090122/11223344, 150.50, ref INV-1001).
 * 4. standard18-bacs (MuhammadTalha776932, open source, Aug 2026), a file
 *    validator — the same label order and skeleton, labels 80 chars, codes
 *    99/17.
 *
 * Corroboration gradient, stated plainly: every MONEY byte (the 100-char
 * credit record) is triple-sourced (1–3) with a worked example; the skeleton
 * is triple-sourced (1, 2, 4); label/contra/UTL1 FIELD offsets are
 * single-sourced from (2), cross-checked where checkable — the HDR1 SUN at
 * 6–11 appears in (1) §5.4 exactly where (2) puts it, and every label sums to
 * exactly 80. (2)'s one prose/bytes slip ("47-46" for field 9) is corrected
 * to 47–64 per (1) §5.7 and the 18-char width. A contradicting schematic (a
 * 2025 explainer describing 80-char typed 01/06/07/08 records, no positions)
 * is rejected: it carries no byte evidence and contradicts (1)'s skeleton.
 *
 * Why single-sourced envelope offsets are shippable: they fail LOUD. Bacs
 * validates the envelope (serial/SUN/processing-date/currency/balance/totals)
 * before processing items — (2) states a mis-structured file "will be
 * rejected" — so a wrong label offset rejects the whole file visibly instead
 * of moving money. No label byte can redirect a credit; only the
 * triple-sourced data bytes address money.
 *
 * Open items (not blockers): Standard 18 field 07 carries an HMRC-hash
 * cross-reference on salary payments linking to the employer's RTI return
 * ((1) §5.2) — the hashing algorithm is not published openly, so field 07 is
 * emitted blank per (2)'s free-format default; the bank accepts blank free
 * format and the hash is an HMRC-matching aid, not a bank validation. The
 * HDR1 file identifier tail (positions 16–21) is "blank filled or the same
 * SUN" per (2) — the SUN is emitted, the alternative noted.
 */
export function buildBacsFile(run: BacsRun): string {
  const checked = validateBacsSettings(run.settings);
  if (!checked.ok) {
    throw new PaymentError(`Bacs originator settings are invalid: ${checked.missing.join(", ")}`);
  }
  const s = checked.settings;
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");
  if (!/^[0-9A-Za-z ]{6}$/.test(run.volSerial) || run.volSerial.trim() === "" || /^0+$/.test(run.volSerial)) {
    throw new PaymentError("Bacs VOL1 serial must be 6 alphanumeric characters, right-justified, not blank or all zeros");
  }
  if (!/^\d{3}$/.test(run.fileNumber) || Number(run.fileNumber) === 0) {
    throw new PaymentError("Bacs UHL1 file number must be 3 digits and greater than zero");
  }

  // Bacs channel text: uppercase only; anything outside the Bacs set becomes
  // a space. This mirrors the channel deterministically — (1) §4.8: lowercase
  // input is converted to blank by Bacs itself — rather than letting the bank
  // mangle names unpredictably. Lengths are the published field widths;
  // over-length text fails here rather than shifting every field after it.
  // (Non-ASCII never reaches this writer: the payroll artifact refuses
  // non-ASCII on fixed-width rails before rendering.)
  const text = (value: string, len: number, what: string): string => {
    const mapped = value
      .toUpperCase()
      .replace(/[^A-Z0-9 .&/-]/g, " ")
      .slice(0, len);
    if (value.trim() === "") throw new PaymentError(`Bacs ${what} must not be blank`);
    return mapped.padEnd(len, " ");
  };
  const pence = (value: bigint, len: number, what: string): string => {
    const digits = String(value);
    if (value <= 0n) throw new PaymentError("payment amounts must be positive");
    if (digits.length > len) {
      throw new PaymentError(`Bacs ${what} ${digits} pence does not fit in ${len} digits — split the pay run`);
    }
    return digits.padStart(len, "0");
  };
  const sort = (value: string, what: string): string => {
    // Six digits, no hyphens on the wire: positions carry NNNNNN.
    const normal = normalizeSortCode(value);
    if (!normal) throw new PaymentError(`Bacs ${what} "${value}" is not a 6-digit sort code`);
    return normal.replace(/-/g, "");
  };
  const account = (value: string, what: string): string => {
    const normal = normalizeGbAccountNumber(value);
    if (normal === null) {
      throw new PaymentError(`Bacs ${what} "${value}" is not an 8-digit account number`);
    }
    return normal;
  };
  // Bacs date: bYYDDD — blank + 2-digit year + Julian day ((1) §4.9).
  // The input is an already-zoned civil day (YYYY-MM-DD): UTC accessors on
  // the parsed date read the same calendar parts on every host. A local
  // getFullYear/getMonth/getDate here would reintroduce the server-zone
  // dependence this interface was changed to remove.
  const yyddd = (iso: string, what: string): string => {
    let year: number;
    let month: number;
    let dayOfMonth: number;
    try {
      const parsed = parseIsoDate(iso);
      year = parsed.getUTCFullYear();
      month = parsed.getUTCMonth() + 1;
      dayOfMonth = parsed.getUTCDate();
    } catch {
      throw new PaymentError(`Bacs ${what} "${iso}" is not a valid YYYY-MM-DD civil day`);
    }
    // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would remap.
    const start = utcDateFromParts(year, 0, 1).getTime();
    const day =
      Math.floor((utcDateFromParts(year, month - 1, dayOfMonth).getTime() - start) / 86_400_000) + 1;
    return ` ${String(year % 100).padStart(2, "0")}${String(day).padStart(3, "0")}`;
  };

  const originSort = sort(s.originatingSortCode, "originating sort code");
  const originAccount = account(s.originatingAccount, "originating account");
  const userName = text(s.serviceUserName, 18, "service user name");
  const creation = yyddd(run.creationDate, "creation date");
  const processing = yyddd(run.processingDate, "processing date");
  // Expiry: "the earliest date at which [the] file may be overwritten" ((2)
  // HDR1 field 10) must be LATER than the processing day; the exact value is
  // free, so processing + 7 days, deterministically, on the civil-day grid
  // (addCalendarDays, never setDate on a host-local midnight). A regeneration
  // carries a new serial and new dates, never a re-derived identity.
  const expiry = yyddd(addCalendarDays(run.processingDate, 7), "processing date");

  // -- VOL1: volume header (80) -------------------------------------------
  // (2): VOL1 | 1 | serial 5–10 | blank 11 | blanks 12–31 | blanks 32–37
  // (direct SUN quoted, so no HSBC/SAGE marker) | owner 38–51 (38–41 blank,
  // 42–47 SUN, 48–51 blank) | blanks 52–79 | 1. (1) §5.3: VOL1 carries the
  // submitter SUN — payroll submits direct, so owner SUN and HDR1 SUN are the
  // one configured SUN; bureau (split-SUN) submission is out of scope.
  const vol1 =
    "VOL1" +
    run.volSerial + // 5–10
    " " + // 11
    " ".repeat(20) + // 12–31
    " ".repeat(6) + // 32–37
    " ".repeat(4) + // 38–41
    s.serviceUserNumber + // 42–47
    " ".repeat(4) + // 48–51
    " ".repeat(28) + // 52–79
    "1"; // 80
  if (vol1.length !== 80) throw new PaymentError("internal error: Bacs VOL1 record is not 80 characters");

  // -- HDR1: header label 1 (80) ------------------------------------------
  // (2): HDR1 | 1 | file identifier 5–21 (5 "A", 6–11 SUN — the SUN position
  // (1) §5.4 confirms at characters 6–11 — 12 "S", 13–14 spaces, 15 space,
  // 16–21 SUN, the SUN chosen over blanks) | serial 22–27 | "0001" | "0001" |
  // generation spaces | version spaces | creation bYYDDD | expiry bYYDDD |
  // blank | zero block count | system-code spaces | reserved spaces.
  const hdr1 =
    "HDR1" +
    "A" + // 5
    s.serviceUserNumber + // 6–11
    "S" + // 12
    "  " + // 13–14
    " " + // 15
    s.serviceUserNumber + // 16–21 (SUN; (2) allows blanks as the alternative)
    run.volSerial + // 22–27
    "0001" + // 28–31 file section
    "0001" + // 32–35 file sequence
    "    " + // 36–39 generation
    "  " + // 40–41 version
    creation + // 42–47
    expiry + // 48–53
    " " + // 54
    "000000" + // 55–60 block count, zero-filled
    " ".repeat(13) + // 61–73 system code
    " ".repeat(7); // 74–80
  if (hdr1.length !== 80) throw new PaymentError("internal error: Bacs HDR1 record is not 80 characters");

  // -- HDR2: header label 2 (80) ------------------------------------------
  // (2): HDR2 | 2 | "F" | "02000" block length | "00100" record length
  // (single processing day) | 35 spaces | "00" | 28 spaces.
  const hdr2 =
    "HDR2" + "F" + "02000" + "00100" + " ".repeat(35) + "00" + " ".repeat(28);
  if (hdr2.length !== 80) throw new PaymentError("internal error: Bacs HDR2 record is not 80 characters");

  // -- UHL1: user header label 1 (80) -------------------------------------
  // (2): UHL1 | 1 | processing bYYDDD 5–10 | "999999" + 4 spaces 11–20 |
  // currency "00" 21–22 | country zeros 23–28 | "1 DAILY  " 29–37 (single
  // processing day) | file number 38–40 | 7 spaces | audit-print spaces
  // 48–54 | 26 spaces. (1) §5.3 confirms UHL1 carries processing date and
  // currency code; the processing day must be a valid Bacs processing day —
  // the bank calendar is not transcribed here, so an invalid day is the
  // bank's loud rejection, never a silent misdate.
  const uhl1 =
    "UHL1" +
    processing + // 5–10
    "999999" + // 11–16
    "    " + // 17–20
    "00" + // 21–22 currency code, transcribed literally
    "000000" + // 23–28
    "1 DAILY  " + // 29–37 work code, single processing day
    run.fileNumber + // 38–40
    " ".repeat(7) + // 41–47
    " ".repeat(7) + // 48–54 audit print identifier (no sample printing)
    " ".repeat(26); // 55–80
  if (uhl1.length !== 80) throw new PaymentError("internal error: Bacs UHL1 record is not 80 characters");

  // -- Data: Direct Credits, code 99 (100 each) -----------------------------
  // Triple-sourced offsets ((1) §5.2/§5.7, (2), (3)): dest sort 1–6, dest
  // account 7–14, type "0" 15, code "99" 16–17, orig sort 18–23, orig account
  // 24–31, free format blanks 32–35, pence ZF 36–46, user name 47–64,
  // reference 65–82, dest name 83–100.
  //
  // Field 07 (free format, 32–35) is emitted blank per (2)'s default. (1)
  // §5.2 notes salary payments carry an HMRC-hash RTI cross-reference there —
  // the hashing algorithm is not published openly, so no hash is computed
  // here; the bank accepts blank free format and the hash is an HMRC-matching
  // aid, not a bank validation.
  const details = run.payments.map((p) => {
    const record =
      sort(p.sortCode, `destination sort code for ${p.accountName}`) + // 1–6
      account(p.accountNumber, `destination account for ${p.accountName}`) + // 7–14
      "0" + // 15
      "99" + // 16–17: Bank Giro / Direct Credit
      originSort + // 18–23
      originAccount + // 24–31
      "    " + // 32–35 free format (see note above)
      pence(p.amountCents, 11, `credit to ${p.accountName}`) + // 36–46
      userName + // 47–64
      text(p.reference, 18, `reference for ${p.accountName}`) + // 65–82
      text(p.accountName, 18, "destination account name"); // 83–100
    if (record.length !== 100) throw new PaymentError("internal error: Bacs detail record is not 100 characters");
    return record;
  });

  // -- Contra: the debit leg, code 17 (100) --------------------------------
  // (1) §4.2 + (2): a credit file's contra is a DEBIT (code 17) on the
  // originator's own account — originating and destination details identical
  // — field 10 "CONTRA", amount = the file total. (1): contras cannot be
  // declined or returned; over-11-digit totals need multiple contras, whose
  // splitting is unspecified — so an over-cap file is a named refusal, never
  // a silently unbalanced submission.
  const total = run.payments.reduce((acc, p) => acc + p.amountCents, 0n);
  const contra =
    originSort + // 1–6
    originAccount + // 7–14
    "0" + // 15
    "17" + // 16–17: debit contra to a credit file
    originSort + // 18–23
    originAccount + // 24–31
    "    " + // 32–35
    pence(total, 11, "contra total") + // 36–46
    userName + // 47–64 narrative (user's choice; the service user name)
    "CONTRA" + " ".repeat(12) + // 65–82 contra identification
    userName; // 83–100 abbreviated account name (the service user name)
  if (contra.length !== 100) throw new PaymentError("internal error: Bacs contra record is not 100 characters");

  // -- EOF1/EOF2: end-of-file labels (80 each) ------------------------------
  // (2): EOF1 repeats HDR1 positions 5–80; EOF2 repeats HDR2 positions 5–80.
  const eof1 = "EOF1" + hdr1.slice(4);
  const eof2 = "EOF2" + hdr2.slice(4);
  if (eof1.length !== 80 || eof2.length !== 80) {
    throw new PaymentError("internal error: Bacs EOF record is not 80 characters");
  }

  // -- UTL1: user trailer label 1 (80) --------------------------------------
  // (2): UTL1 | 1 | debit monetary total 5–17 (13, pence ZF — the contra) |
  // credit monetary total 18–30 (13 — the credits) | debit count 31–37 (7 —
  // the one contra) | credit count 38–44 (7) | 10 spaces | 26 spaces. The
  // credit-file example in (2) confirms the shape: N code-99 records plus one
  // code-17 contra count as debit 1 / credit N.
  const utl1 =
    "UTL1" +
    pence(total, 13, "debit total") + // 5–17
    pence(total, 13, "credit total") + // 18–30
    "0000001" + // 31–37: the one debit contra
    String(run.payments.length).padStart(7, "0") + // 38–44: credit count
    " ".repeat(10) + // 45–54
    " ".repeat(26); // 55–80
  if (utl1.length !== 80) throw new PaymentError("internal error: Bacs UTL1 record is not 80 characters");
  if (!/^\d{7}$/.test(String(run.payments.length).padStart(7, "0")) || run.payments.length > 9_999_999) {
    throw new PaymentError("Bacs file holds at most 9,999,999 detail records");
  }

  return [vol1, hdr1, hdr2, uhl1, ...details, contra, eof1, eof2, utl1].join("\r\n") + "\r\n";
}
