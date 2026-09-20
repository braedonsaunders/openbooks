import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, formatMoney, sum, toUnits } from "../money/money.ts";
import { buildBacsFile, buildCemtexFile, buildCpa005File, buildNachaFile, buildSepaFile, buildCnab240BbFile, buildZenginFile, encodeZenginFile, type BacsPayment, type CemtexPayment, type Cpa005Payment, type NachaEntry, type Cnab240BbPayment, type ZenginPayment } from "../payments/rail-formatters.ts";
import { decryptAccountNumber, isValidBic, isValidIban, inscricaoTipoFor, isValidBancoCode, isValidContaDv, normalizeAgencia, normalizeBankCode, normalizeContaNumero, normalizeCpfCnpj, normalizeBranchCode, normalizeBsb, normalizeZenginAccount, toZenginKana, normalizeCemtexAccount, normalizeGbAccountNumber, normalizeSortCode, validateBacsSettings, validateCnab240BbSettings, validateZenginSettings, validateCemtexSettings, validateSepaSettings, type BacsSettings, type Cnab240BbSettings, type ZenginSettings, type CemtexSettings, type EftSettings, type NachaSettings, type SepaSettings } from "../payments/rail-settings.ts";
import { stubPaymentMethods } from "./payment-method.ts";
import { PayrollError } from "./error.ts";
import { unsealJson } from "../platform/secrets.ts";

/**
 * Payroll direct-deposit file — the bytes.
 *
 * This module turns a committed pay run into the exact characters a bank will
 * read. It does NOT decide whether the run is allowed to have a file, does not
 * persist anything, and does not allocate a number: that lifecycle lives in
 * ./payroll-bank-file-artifact.ts, and nothing here may be called without it.
 * Keeping the split means the format can be unit-tested byte for byte against
 * a golden file with no database and no side effects.
 *
 * Two rules govern everything below.
 *
 * 1. A bank file is EFT ONLY. The population comes from
 *    `payRunBankFilePopulation`, which partitions the run through the one
 *    payment-method resolver; a cheque employee credited here as well as
 *    handed paper is paid twice.
 * 2. Institution-specific values are NEVER invented. Originator id, data
 *    centre, ODFI routing, company id, CPA transaction code and NACHA entry
 *    class all come from the tenant's payment bank profile
 *    (Setup → Payment operations), and a missing one is a named refusal, not
 *    a default.
 *
 * Format enablement is per format, not global: a format whose layout cannot be
 * established with confidence stays off rather than emitting characters a bank
 * would reject or, worse, misread.
 */

/** Export is live; individual formats are gated by PAYROLL_BANK_FILE_FORMATS. */
export const PAYROLL_BANK_FILE_EXPORT_ENABLED = true;

export type PayRunBankFileFormat = "cpa005" | "nacha" | "sepa" | "cemtex" | "bacs" | "zengin" | "cnab240";

export interface PayRunBankFileFormatSpec {
  /** Off means: do not emit these bytes, and say why. */
  enabled: boolean;
  /** ISO currency the rail settles in; the run must match. */
  currency: string;
  /** payment_formats.rail values that carry this format's originator config. */
  rails: string[];
  extension: string;
  contentType: string;
  /** Why the format is off, when it is. */
  disabledReason?: string;
}

/**
 * The three rails this product can originate payroll on, and the published
 * standards their layouts were verified against.
 *
 * ── CPA-005 (Canada) — ON ─────────────────────────────────────────────────
 * Verified clause by clause against Payments Canada, *Standard 005 — Standards
 * for the Exchange of Financial Data on AFT Files* (2024 ed.,
 * payments.ca/sites/default/files/standard005eng.pdf), read directly:
 *
 * - Section D (introduction): logical record types A, C and Z are exactly
 *   1464 characters. The standard's EBCDIC clause governs exchange BETWEEN
 *   institutions; customer-to-direct-clearer files are ASCII + CRLF per the
 *   direct clearers' own implementation guides (Scotiabank, Central 1).
 * - Section D p.4, Logical Record Type A layout table: "A" (1), Logical
 *   Record Count = literal "000000001" (2–10), Originator's ID (11–20), File
 *   Creation No. (21–24), Creation Date `0yyddd` (25–30), Destination Data
 *   Centre (31–35), reserved communication area (36–55), Currency Code
 *   Identifier "CAD" (56–58), filler to 1464.
 * - Section D p.5, Logical Record Type C layout table: elements 01–03
 *   ("C", Logical Record Count, Origination Control Data, positions 1–24),
 *   then up to six 240-character credit segments from position 25. All
 *   eighteen segment elements (04–21) sit at their published offsets; the
 *   Item Trace Number is element 09, record positions 65–86 = positions
 *   41–62 within the segment.
 * - Section D, Logical Record Type Z layout table: Total Value/Number of
 *   Debit Transactions "D" and "J" (25–38, 39–46), Total Value/Number of
 *   Credit Transactions "C" and "I" (47–60, 61–68), Error Corrections "E"
 *   and "F" (69–112), filler to 1464.
 * - Appendix 1 (Data Element Dictionary) pp.6–7, ITEM TRACE NUMBER, and
 *   pp.3–4, DESTINATION DATA CENTRE / FILE CREATION NUMBER / LOGICAL RECORD
 *   COUNT — see below and `itemTraceNumber` in engine/src/payments/rail-formatters.ts.
 * - Transaction codes against *Standard 007* (2026 ed., Appendix I — codes
 *   moved out of Standard 005 in 2016): 200 = Payroll Deposit, 460 = Accounts
 *   Payable.
 * - Amounts are unsigned implied cents, right-justified zero-filled (the
 *   standard's own worked example agrees; Scotiabank's and Central 1's
 *   implementation guides state it outright).
 *
 * The element that used to keep this format OFF is DE 12, the ITEM TRACE
 * NUMBER. Appendix 1 pp.6–7 mandates its internal structure: (a) the 4-digit
 * destination data centre with the trailing digit dropped — which must agree
 * with the A record's Destination Data Centre or the transaction is REJECTED —
 * (b) the originating direct clearer's 5-digit allocated data centre, (c) the
 * 4-digit file creation number as per the A record, and (d) a 9-digit item
 * sequence number, where (b), (c) and (d) must each be greater than zero or
 * the transaction is REJECTED. `buildCpa005File` (engine/src/payments/rail-formatters.ts)
 * now composes exactly that via `itemTraceNumber`, shared with the AP payment
 * files. Both data centres are institution-assigned tenant configuration on
 * the payment bank profile (`dataCentre`, `originatingDataCentre`; validated
 * 5-digit, never defaulted), and the file creation number is the artifact's
 * own `number_sequences` allocation (payroll-bank-file-artifact.ts) — inside
 * the same transaction that freezes the bytes, never re-derived. Every
 * element is therefore constructible from collected configuration, so the
 * format is on; the zero-fill canary test is replaced by the byte-level
 * golden in payroll-bank-file.test.ts.
 *
 * ── NACHA (United States) — ON ────────────────────────────────────────────
 * Verified against Nacha's *ACH Guide for Developers* (achdevguide.nacha.org,
 * official but abridged relative to Operating Rules Appendix Three, which is
 * paywalled) and corroborated against Hancock Whitney's ACH input file guide.
 * All five record layouts match position for position: File Header (1), Batch
 * Header (5), Entry Detail (6), Batch Control (8), File Control (9), each
 * exactly 94 characters, blocked to a multiple of ten with all-nine filler
 * records, alphanumerics left-justified space-padded and numerics unsigned
 * right-justified zero-padded, amounts in implied cents.
 *
 * ── SEPA (Eurozone) — ON ──────────────────────────────────────────────────
 * pain.001.001.03 Customer Credit Transfer Initiation (EUR), rendered by the
 * shared AP builder (`buildSepaFile`, engine/src/payments/rail-formatters.ts)
 * with the shared ISO 13616 mod-97 IBAN gate — payroll maps its EFT
 * population onto the builder's generic payment rows and adds nothing of its
 * own. The originator triple (debtor name, debtor IBAN, debtor BIC) is tenant
 * configuration on the `sepa_credit` payment bank profile, validated by the
 * shared `validateSepaSettings`; an employee row without a mod-97-valid IBAN
 * is a named refusal, never a silent drop and never a coerced account number.
 * The message identification is the artifact's own `number_sequences`
 * allocation (payroll-bank-file-artifact.ts) — the bank deduplicates on
 * MsgId, so it must be unique per file and is never re-derived.
 *
 * ── CEMTEX (Australia) — ON ─────────────────────────────────────────────
 * The Australian direct-credit file (120-character records: descriptive type
 * 0, detail type 1, file-total type 7; BSBs as NNN-NNN; amounts in implied
 * cents; transaction code 53 = Pay), rendered by the shared AP builder
 * (`buildCemtexFile`, engine/src/payments/rail-formatters.ts) — payroll maps
 * its EFT population onto the builder's generic payment rows and adds
 * nothing of its own, so AP can originate the same rail later with no fork.
 * The name is `cemtex`, never `aba`: ABA already means the US 9-digit
 * routing number throughout the payments module, and a format keyed `aba`
 * would read as the US concept to every future reader.
 *
 * Offsets verified position for position against three concordant published
 * transcriptions: Cemtex's own "ABA file format technical details"
 * (cemtexaba.com, retrieved 2026-09-20); M. Cordover's annotated
 * sample-with-comments.aba v1.1 (2013-04-07, CC-BY 3.0 AU), which names the
 * formal specification — APCA BECS Procedures Appendix C2 (pp. 78–85), char
 * set C7 (p. 86) — whose PDF is no longer reachable (APCA became AusPayNet
 * in 2017); and the aba-generator 2.1.0 record schemas. All three agree on
 * every field boundary. An employee row without a shaped BSB and a 1–9
 * digit account number is a named refusal, never a silent drop and never a
 * coerced account (a coerced BSB pays a stranger).
 *
 * All writers are the audited AP ones in engine/src/payments/rail-formatters.ts
 * (`buildCpa005File`, `buildNachaFile`, `buildSepaFile`, `buildCemtexFile`, `buildBacsFile`, `buildZenginFile`) — payroll deliberately does not fork a
 * second implementation of a fixed-width money format.
 *
 * ── BACS (United Kingdom) — ON ────────────────────────────────────────────
 * The Bacs Standard 18 Direct Credit submission (80-char VOL1/HDR1/HDR2/UHL1
 * labels, 100-char code-99 credit records, a code-17 debit contra, EOF1/EOF2
 * and the UTL1 totals trailer), rendered by the shared AP builder
 * (`buildBacsFile`, engine/src/payments/rail-formatters.ts) — payroll maps
 * its EFT population onto the builder's generic payment rows and adds
 * nothing of its own, so AP can originate the same rail later with no fork.
 * Single-processing-day, single-SUN direct submission only. The formal
 * specification (Bacs Electronic Funds Transfer, File Structures, PN5011
 * v3.10) is published to service users and members rather than openly; the
 * writer's evidence log — three concordant transcriptions plus a worked
 * example for the money bytes, single-transcription envelope offsets that
 * fail loud at bank validation — is on `buildBacsFile`, which names every
 * source with publisher, edition and date. An employee row without a shaped
 * sort code and 8-digit account is a named refusal, never a silent drop and
 * never a coerced account (a coerced sort code pays a stranger). No bank has
 * cleared a file from this writer; Bacs is a weaker evidence class than
 * Cemtex.
 *
 * ── ZENGIN (Japan) — ON ─────────────────────────────────────────────────
 * 給与振込 (salary transfer, 種別コード 11) in 全銀協規定形式: 120-byte
 * header (1), one 120-byte data record (2) per payment, 120-byte trailer
 * (8) and end record (9), CRLF-terminated, Shift_JIS bytes — rendered by
 * the shared AP builder (`buildZenginFile` + `encodeZenginFile`,
 * engine/src/payments/rail-formatters.ts). Payroll maps its EFT population
 * onto the builder's generic payment rows and adds nothing of its own, so
 * AP can originate the same rail later with no fork. Seven bank-published
 * manuals (MUFG BizStation, Chiba, Tajima, Kiraboshi, Tsuruga Shinkin, MUFG
 * Trust, Docomo SMTB Net Bank) agree on every field boundary; the writer's
 * evidence log names every source with publisher and date and states the
 * corroboration gradient. A Japanese credit is addressed by 4-digit bank
 * code + 3-digit branch code + 種目 + 7-digit account — validated by shape,
 * never through the IBAN validator — and the payee name travels as
 * half-width katakana: a name with no mechanical kana reading (kanji) is a
 * named refusal with the フリガナ remedy, never a guessed reading. JPY has
 * no minor unit, so sub-yen net pay is refused, never rounded.
 *
 * No bank has cleared a file from this writer; Zengin is a weaker evidence
 * class than Cemtex.
 *
 * ── CNAB 240, Banco do Brasil variant (Brazil) — ON ─────────────────────────
 * The FEBRABAN CNAB 240 Pagamentos credit file as Banco do Brasil accepts it
 * (header de arquivo, forma-01 / forma-41 lotes with tipo de serviço '30',
 * one Segmento A + Segmento B pair per payment, trailer de lote, trailer de
 * arquivo), rendered by the shared AP builder (`buildCnab240BbFile`,
 * engine/src/payments/rail-formatters.ts) — payroll maps its EFT population
 * onto the builder's generic payment rows and adds nothing of its own, so
 * AP can originate the same rail later with no fork. CNAB 240 is
 * bank-specific in places (BB `convênio + '0126'` vs Bradesco's 20-char
 * convênio, arquivo versions, the 178–230 tail): this rail is the BB variant
 * and says so — the rail is `cnab240_bb_credit`, the builder and settings
 * carry the `Bb` suffix, and the writer's evidence log names every source
 * with publisher, edition and date. The money bytes are five-sourced (two
 * bank-published manuals plus three independent implementations); the
 * BB-flavored envelope choices fail loud at bank validation — see the
 * builder. Same-bank (BB) employees ride forma 01 / câmara 000; other-bank
 * employees ride forma 41 / TED câmara 018 in a second lote. An employee row
 * without a shaped agência/conta/DVs, a 3-digit bank code or a check-digit-
 * valid CPF/CNPJ is a named refusal, never a silent drop and never a
 * coerced account (a coerced agência pays a stranger). No bank has
 * cleared a file from this writer; CNAB 240 is a weaker evidence class
 * than Cemtex.
 */
export const PAYROLL_BANK_FILE_FORMATS: Record<PayRunBankFileFormat, PayRunBankFileFormatSpec> = {
  cpa005: {
    enabled: true,
    currency: "CAD",
    rails: ["cpa005_credit"],
    extension: "txt",
    // CPA-005 customer-to-bank files are ASCII (the standard's own EBCDIC
    // clause governs direct-clearer-to-direct-clearer exchange).
    contentType: "text/plain; charset=us-ascii",
  },
  nacha: {
    enabled: true,
    currency: "USD",
    rails: ["nacha_credit"],
    extension: "ach",
    contentType: "text/plain; charset=us-ascii",
  },
  sepa: {
    enabled: true,
    currency: "EUR",
    rails: ["sepa_credit"],
    extension: "xml",
    contentType: "application/xml",
  },
  cemtex: {
    enabled: true,
    currency: "AUD",
    rails: ["cemtex_credit"],
    extension: "aba",
    contentType: "text/plain; charset=us-ascii",
  },
  bacs: {
    enabled: true,
    currency: "GBP",
    rails: ["bacs_credit"],
    extension: "txt",
    contentType: "text/plain; charset=us-ascii",
  },
  zengin: {
    enabled: true,
    currency: "JPY",
    rails: ["zengin_credit"],
    extension: "txt",
    // Shift_JIS, never UTF-8: text fields are half-width katakana and the
    // bank reads Shift_JIS bytes (see `buildZenginFile` /
    // `encodeZenginFile`, engine/src/payments/rail-formatters.ts).
    contentType: "text/plain; charset=Shift_JIS",
  },
  cnab240: {
    enabled: true,
    currency: "BRL",
    rails: ["cnab240_bb_credit"],
    extension: "rem",
    contentType: "text/plain; charset=us-ascii",
  },
};

/** One credit on the direct-deposit file. */
export interface PayRunBankFileEntry {
  stubId: string;
  employeePartyId: string;
  employeeName: string;
  amount: string;
}

/** Why an employee is not on the file. Mirrors the resolver's `source`. */
export type ChequeExclusionReason =
  /** employee_payroll_profiles.payment_method says cheque. */
  | "profile"
  /** parties.payment_method says cheque (or a non-payroll method). */
  | "party"
  /** Nothing configured and no approved bank details. */
  | "default"
  /** Configured EFT but has no approved bank details; org pays on paper. */
  | "eftFallback";

export interface ChequeExclusion {
  employeePartyId: string;
  employeeName: string;
  amount: string;
  reason: ChequeExclusionReason;
}

export interface PayRunBankFilePopulation {
  entries: PayRunBankFileEntry[];
  /** Control total of the file — the money the EFT debit will draw. */
  total: string;
  /** Employees settled on paper instead; they are NOT on the file. */
  excludedCheque: ChequeExclusion[];
  /** Net pay of the paper population. entries total + this = the run's net pay. */
  excludedTotal: string;
}

/**
 * Who is on the direct-deposit file, and for how much.
 *
 * A bank file is EFT ONLY. Cheque employees are deliberately excluded rather
 * than filtered out incidentally by "has bank details": an employee can hold
 * approved bank details and still be paid by cheque, and crediting their
 * account as well as handing them paper pays them twice. The rail comes from
 * the one resolver (engine/src/payroll/payment-method.ts) so the file, the
 * cheque batch and the funding panel always partition the same population.
 *
 * The exclusion carries its REASON, because the artifact stores this list as
 * the operator's reconciliation evidence: "seven people are not on the file"
 * is only useful next to why each of them is not.
 */
export async function payRunBankFilePopulation(
  orgId: string,
  documentId: string,
): Promise<PayRunBankFilePopulation> {
  const stubs = await stubPaymentMethods(orgId, documentId);
  const entries = stubs
    .filter((stub) => stub.method === "eft")
    .map((stub) => ({
      stubId: stub.stubId,
      employeePartyId: stub.employeePartyId,
      employeeName: stub.name,
      amount: stub.netPay,
    }));
  const excludedCheque: ChequeExclusion[] = stubs
    .filter((stub) => stub.method === "cheque")
    .map((stub) => ({
      employeePartyId: stub.employeePartyId,
      employeeName: stub.name,
      amount: stub.netPay,
      reason: stub.source,
    }));
  return {
    entries,
    total: sum(entries.map((entry) => entry.amount)),
    excludedCheque,
    excludedTotal: sum(excludedCheque.map((entry) => entry.amount)),
  };
}

// ---------------------------------------------------------------------------
// Tenant originator configuration
// ---------------------------------------------------------------------------

/**
 * The originator half of a payroll file, read from the tenant's payment bank
 * profile. Nothing here is derivable — every value is assigned by the
 * employer's financial institution — so this resolver only ever reports what
 * the org configured, or names exactly what is missing.
 *
 * Payroll deliberately does NOT inherit the AP profile's CPA transaction code
 * or the AP NACHA defaults (460 = accounts payable, CCD = corporate credit).
 * A payroll credit is a different instrument to a supplier payment, so the
 * payroll-facing values are required on the profile rather than defaulted:
 * the employer points payroll at a profile they created for payroll.
 */
export interface PayrollOriginatorConfig {
  paymentBankProfileId: string;
  profileName: string;
  format: PayRunBankFileFormat;
  currency: string;
  /**
   * Record terminator. Nacha's published guide defines the 94-character record
   * and says NOTHING about line terminators; LF, CRLF and terminator-free
   * blocked streams are all in live use and acceptance is per-ODFI. So it is
   * tenant configuration (`payment_bank_profiles.settings.lineEnding`),
   * defaulting to the writer's LF, and it is shown to the operator before they
   * generate rather than being an invisible assumption. The terminator never
   * counts toward the 94 characters either way.
   */
  lineEnding: "lf" | "crlf";
  cpa005?: EftSettings & { transactionCode: string };
  nacha?: NachaSettings & { entryClassCode: "PPD" | "CCD"; entryDescription: string };
  sepa?: SepaSettings;
  cemtex?: CemtexSettings;
  bacs?: BacsSettings;
  zengin?: ZenginSettings;
  cnab240bb?: Cnab240BbSettings;
}

export type PayrollOriginatorResult =
  | { ok: true; config: PayrollOriginatorConfig }
  | { ok: false; profileName: string; missing: string[] };
type ProfileRow = {
  id: string;
  name: string;
  currency: string | null;
  rail: string;
  settings: Record<string, unknown> | null;
  originator_secrets_encrypted: string | null;
};

/** CPA-005 is CRLF-terminated per the bank implementation guides; NACHA is per-ODFI; SEPA pain.001 is LF-terminated XML; Cemtex files are CR/LF-delimited per the annotated sample; Bacs files are CR/LF-delimited per the byte-level implementation. */
function lineEndingFor(row: ProfileRow, format: PayRunBankFileFormat): "lf" | "crlf" {
  if (format === "cpa005") return "crlf";
  if (format === "sepa") return "lf";
  if (format === "cemtex") return "crlf";
  if (format === "bacs") return "crlf";
  if (format === "zengin") return "crlf";
  if (format === "cnab240") return "crlf";
  return String(row.settings?.lineEnding ?? "").toLowerCase() === "crlf" ? "crlf" : "lf";
}

/** Active payroll-capable originator profiles, for the operator's picker. */
export async function payrollBankProfiles(orgId: string): Promise<
  { id: string; name: string; format: PayRunBankFileFormat; currency: string | null; configured: boolean }[]
> {
  const rails = Object.values(PAYROLL_BANK_FILE_FORMATS).flatMap((spec) => spec.rails);
  const rows = (await db.execute<ProfileRow>(sql`
    select p.id, p.name, p.currency, f.rail, p.settings, p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.is_active
       and f.rail = any(${`{${rails.join(",")}}`}::text[])
     order by p.name
  `));
  return rows.rows.map((row) => {
    const format = formatForRail(row.rail)!;
    return {
      id: row.id,
      name: row.name,
      format,
      currency: row.currency,
      configured: resolveOriginator(row, format).ok,
    };
  });
}

function formatForRail(rail: string): PayRunBankFileFormat | null {
  for (const [format, spec] of Object.entries(PAYROLL_BANK_FILE_FORMATS)) {
    if (spec.rails.includes(rail)) return format as PayRunBankFileFormat;
  }
  return null;
}

const FILL_ME = (value: unknown) =>
  typeof value !== "string" || value.trim() === "" || value.includes("FILL-ME");

/**
 * CPA-005 originator validation.
 *
 * Widths and formats are the ones the standard fixes: originator ID is 10
 * characters (positions 11–20 of every record), the destination data centre is
 * 5 digits (positions 31–35 of the A record), and the return routing is a
 * 3-digit institution plus 5-digit transit (the 9-character institutional ID
 * "0" + III + TTTTT). The short/long originator names are what the payee sees
 * on their statement, 15 and 30 characters.
 *
 * TWO data centres, both institution-assigned, both trace-number components
 * (Standard 005, Appendix 1 pp.6–7): `dataCentre` is the DESTINATION data
 * centre the file is delivered to (A record positions 31–35; its first four
 * digits open every item trace number and must agree or the transaction is
 * rejected), and `originatingDataCentre` is the originating direct clearer's
 * own allocated data centre (trace positions 5–9, which must be greater than
 * zero or the transaction is rejected). Neither is derivable from the other,
 * so both are required configuration.
 *
 * `transactionCode` is REQUIRED for payroll: CPA transaction type 200 is a
 * payroll deposit, 460 is accounts payable, and silently sending wages under
 * the AP code misdescribes the credit on the employee's statement.
 */
function resolveCpa005(row: ProfileRow): PayrollOriginatorResult {
  const raw = unsealJson<Partial<EftSettings>>(row.originator_secrets_encrypted) ?? {};
  const required: (keyof EftSettings)[] = [
    "originatorId",
    "originatorShortName",
    "originatorLongName",
    "dataCentre",
    "originatingDataCentre",
    "institution",
    "transit",
    "account",
    "transactionCode",
  ];
  const missing = required.filter((key) => FILL_ME(raw[key]));
  const settings = raw as EftSettings;
  if (!missing.includes("dataCentre") && !/^\d{5}$/.test(settings.dataCentre)) {
    missing.push("dataCentre (5 digits)" as keyof EftSettings);
  }
  if (
    !missing.includes("originatingDataCentre") &&
    (!/^\d{5}$/.test(settings.originatingDataCentre) ||
      Number(settings.originatingDataCentre) === 0)
  ) {
    missing.push(
      "originatingDataCentre (5 digits, greater than zero — Standard 005 rejects a zero-filled trace-number component)" as keyof EftSettings,
    );
  }
  if (!missing.includes("institution") && !/^\d{3}$/.test(settings.institution)) {
    missing.push("institution (3 digits)" as keyof EftSettings);
  }
  if (!missing.includes("transit") && !/^\d{5}$/.test(settings.transit)) {
    missing.push("transit (5 digits)" as keyof EftSettings);
  }
  if (!missing.includes("account") && !/^\d{1,12}$/.test(settings.account)) {
    missing.push("account (1–12 digits)" as keyof EftSettings);
  }
  if (!missing.includes("originatorId") && settings.originatorId.length > 10) {
    missing.push("originatorId (max 10 characters)" as keyof EftSettings);
  }
  if (!missing.includes("transactionCode") && !/^\d{3}$/.test(settings.transactionCode ?? "")) {
    missing.push("transactionCode (3-digit CPA code; payroll deposit is 200)" as keyof EftSettings);
  }
  if (missing.length > 0) return { ok: false, profileName: row.name, missing: missing.map(String) };
  return {
    ok: true,
    config: {
      paymentBankProfileId: row.id,
      profileName: row.name,
      format: "cpa005",
      currency: row.currency ?? "CAD",
      lineEnding: "crlf",
      cpa005: { ...settings, transactionCode: settings.transactionCode! },
    },
  };
}

/**
 * NACHA originator validation.
 *
 * The ODFI routing number is the 9-digit ABA of the originating bank; its
 * first 8 digits fill the "Originating DFI Identification" field (positions
 * 80–87 of the batch header/control) and prefix every 15-character trace
 * number. Immediate destination/origin are the 10-character fields at
 * positions 4–13 and 14–23 of the file header, and the company identification
 * is the 10-character field the receiving bank reconciles the batch by.
 *
 * Two values are NOT read from the profile, because they are standardized by
 * Nacha rather than assigned by an institution, and letting a tenant vary them
 * would produce a non-compliant file:
 *
 * - the standard entry class is PPD. Direct deposit of wages goes to an
 *   employee's CONSUMER account; PPD is Nacha's corporate-to-consumer class.
 *   CCD is corporate-to-corporate (vendor payments, funding a disbursement
 *   account) and is what the AP writer defaults to, so a profile configured
 *   for AP is refused here rather than quietly reused.
 * - the company entry description is "PAYROLL". Since the Nacha rule effective
 *   20 March 2026 (Risk Management Topics — Company Entry Descriptions) this
 *   is MANDATORY for PPD credits paying wages, salaries and similar
 *   compensation; it is no longer a convention the employer may word.
 */
export const NACHA_PAYROLL_ENTRY_CLASS = "PPD" as const;
export const NACHA_PAYROLL_ENTRY_DESCRIPTION = "PAYROLL";

function resolveNacha(row: ProfileRow): PayrollOriginatorResult {
  const raw = unsealJson<Partial<NachaSettings>>(row.originator_secrets_encrypted) ?? {};
  const required: (keyof NachaSettings)[] = [
    "odfiRouting",
    "immediateDestination",
    "immediateOrigin",
    "destinationName",
    "originName",
    "companyName",
    "companyId",
  ];
  const missing = required.filter((key) => FILL_ME(raw[key]));
  const settings = raw as NachaSettings;
  if (!missing.includes("odfiRouting") && !/^\d{9}$/.test(settings.odfiRouting)) {
    missing.push("odfiRouting (9 digits)" as keyof NachaSettings);
  }
  if (!missing.includes("companyId") && String(settings.companyId).length > 10) {
    missing.push("companyId (max 10 characters)" as keyof NachaSettings);
  }
  // A profile explicitly set up for corporate credits is an AP profile. Paying
  // employees on it would classify consumer credits as corporate ones.
  if (raw.entryClassCode != null && raw.entryClassCode !== NACHA_PAYROLL_ENTRY_CLASS) {
    missing.push(
      `entryClassCode is ${raw.entryClassCode} on this profile; payroll direct deposit to employees must be PPD — use a payroll-specific bank profile` as keyof NachaSettings,
    );
  }
  if (missing.length > 0) return { ok: false, profileName: row.name, missing: missing.map(String) };
  return {
    ok: true,
    config: {
      paymentBankProfileId: row.id,
      profileName: row.name,
      format: "nacha",
      currency: row.currency ?? "USD",
      lineEnding: "lf",
      nacha: {
        ...settings,
        entryClassCode: NACHA_PAYROLL_ENTRY_CLASS,
        entryDescription: NACHA_PAYROLL_ENTRY_DESCRIPTION,
      },
    },
  };
}

/**
 * SEPA originator validation.
 *
 * The originator half of a pain.001 credit transfer is three values the
 * employer's bank assigned: the debtor name as it must appear on employee
 * statements, the IBAN the EFT debit will draw, and the debtor agent's BIC.
 * All three are tenant configuration on the payment bank profile (Setup →
 * Payment operations, `sepa_credit` rail) and all three are validated here —
 * the shared `validateSepaSettings` refuses a malformed originator IBAN
 * (mod-97) or BIC by name rather than emitting XML the bank will reject.
 */
function resolveSepa(row: ProfileRow): PayrollOriginatorResult {
  const raw = unsealJson<Partial<SepaSettings>>(row.originator_secrets_encrypted) ?? {};
  const checked = validateSepaSettings(raw);
  if (!checked.ok) {
    return {
      ok: false,
      profileName: row.name,
      missing: checked.missing.map(
        (key) => `${key} (Setup → Payment operations, on this profile; assigned by your financial institution, never defaulted)`,
      ),
    };
  }
  return {
    ok: true,
    config: {
      paymentBankProfileId: row.id,
      profileName: row.name,
      format: "sepa",
      currency: row.currency ?? "EUR",
      lineEnding: "lf",
      sepa: checked.settings,
    },
  };
}

/**
 * Cemtex originator validation.
 *
 * Six values the employer's bank assigned: the 3-letter APCA abbreviation of
 * the processing bank, the supplying-user name, the APCA-allocated Direct
 * Entry user ID, the trace (source) BSB and account the debit draws, and the
 * remitter name employees see on their statements. All six are tenant
 * configuration on the payment bank profile (Setup → Payment operations,
 * `cemtex_credit` rail) and all six are validated by the shared
 * `validateCemtexSettings` — a malformed BSB is refused by name rather than
 * emitted into a BSB field the bank would misread as another account.
 */
function resolveCemtex(row: ProfileRow): PayrollOriginatorResult {
  const raw = unsealJson<Partial<CemtexSettings>>(row.originator_secrets_encrypted) ?? {};
  const checked = validateCemtexSettings(raw);
  if (!checked.ok) {
    return {
      ok: false,
      profileName: row.name,
      missing: checked.missing.map(
        (key) => `${key} (Setup → Payment operations, on this profile; assigned by your financial institution, never defaulted)`,
      ),
    };
  }
  return {
    ok: true,
    config: {
      paymentBankProfileId: row.id,
      profileName: row.name,
      format: "cemtex",
      currency: row.currency ?? "AUD",
      lineEnding: "crlf",
      cemtex: checked.settings,
    },
  };
}

/**
 * Bacs originator validation.
 *
 * The originator half of a Standard 18 credit submission is four values the
 * employer's bank assigned: the 6-digit Service User Number (VOL1 owner and
 * HDR1 SUN), the originating sort code and account the Bacs debit will draw
 * (every data record and the contra), and the service user name employees
 * see on their statements (field 9). All four are tenant configuration on
 * the payment bank profile (Setup → Payment operations, `bacs_credit` rail)
 * and all four are validated by the shared `validateBacsSettings` — a
 * malformed SUN or sort code is refused by name rather than emitted into a
 * field the bank would misread as another account. Payroll submits direct
 * (one SUN in VOL1 and HDR1 alike); bureau split-SUN submission is out of
 * scope — the settings carry a single SUN, so it cannot be expressed.
 */
function resolveBacs(row: ProfileRow): PayrollOriginatorResult {
  const raw = unsealJson<Partial<BacsSettings>>(row.originator_secrets_encrypted) ?? {};
  const checked = validateBacsSettings(raw);
  if (!checked.ok) {
    return {
      ok: false,
      profileName: row.name,
      missing: checked.missing.map(
        (key) => `${key} (Setup → Payment operations, on this profile; assigned by your financial institution, never defaulted)`,
      ),
    };
  }
  return {
    ok: true,
    config: {
      paymentBankProfileId: row.id,
      profileName: row.name,
      format: "bacs",
      currency: row.currency ?? "GBP",
      lineEnding: "crlf",
      bacs: checked.settings,
    },
  };
}

/**
 * Zengin originator validation.
 *
 * The originator half of a 給与振込 file is the bank-assigned 委託者コード
 * (10 digits) and kana 委託者名 plus the originating bank/branch/種目/
 * account the transfer draws on. All are tenant configuration on the payment
 * bank profile (Setup → Payment operations, `zengin_credit` rail) and all
 * are validated by the shared `validateZenginSettings` — a malformed client
 * code or an unmappable (kanji) client name is refused by name rather than
 * emitted into fixed-width fields the bank would misread.
 */
function resolveZengin(row: ProfileRow): PayrollOriginatorResult {
  const raw = unsealJson<Partial<ZenginSettings>>(row.originator_secrets_encrypted) ?? {};
  const checked = validateZenginSettings(raw);
  if (!checked.ok) {
    return {
      ok: false,
      profileName: row.name,
      missing: checked.missing.map(
        (key) => `${key} (Setup → Payment operations, on this profile; assigned by your financial institution, never defaulted)`,
      ),
    };
  }
  return {
    ok: true,
    config: {
      paymentBankProfileId: row.id,
      profileName: row.name,
      format: "zengin",
      currency: row.currency ?? "JPY",
      lineEnding: "crlf",
      zengin: checked.settings,
    },
  };
}

/**
 * CNAB 240 (Banco do Brasil variant) originator validation.
 *
 * The originator half of a CNAB 240 remessa is the employer's convênio
 * coordinates at Banco do Brasil: the 9-digit payment convênio (header
 * arquivo/lote 33–41, with '0126' pinned at 42–45), the debit agência and
 * conta with their check digits, the employer CNPJ and the company name.
 * All are tenant configuration on the payment bank profile (Setup →
 * Payment operations, `cnab240_bb_credit` rail) and all are validated by
 * the shared `validateCnab240BbSettings` — a malformed convênio or CNPJ is
 * refused by name rather than emitted into a field the bank would misread
 * as another agreement. This rail transmits to Banco do Brasil only: an
 * Itaú/Bradesco/Santander employer needs that bank's variant, which is a
 * different layout, not a different configuration.
 */
function resolveCnab240Bb(row: ProfileRow): PayrollOriginatorResult {
  const raw = unsealJson<Partial<Cnab240BbSettings>>(row.originator_secrets_encrypted) ?? {};
  const checked = validateCnab240BbSettings(raw);
  if (!checked.ok) {
    return {
      ok: false,
      profileName: row.name,
      missing: checked.missing.map(
        (key) => `${key} (Setup → Payment operations, on this profile; assigned by Banco do Brasil with your convênio, never defaulted)`,
      ),
    };
  }
  return {
    ok: true,
    config: {
      paymentBankProfileId: row.id,
      profileName: row.name,
      format: "cnab240",
      currency: row.currency ?? "BRL",
      lineEnding: "crlf",
      cnab240bb: checked.settings,
    },
  };
}

function resolveOriginator(row: ProfileRow, format: PayRunBankFileFormat): PayrollOriginatorResult {
  // Branch on the profile's rail-mapped format, never on a country: packs
  // declare which rail they settle on and this resolver only reads it.
  const resolved =
    format === "cpa005" ? resolveCpa005(row) : format === "sepa" ? resolveSepa(row) : format === "cemtex" ? resolveCemtex(row) : format === "bacs" ? resolveBacs(row) : format === "zengin" ? resolveZengin(row) : format === "cnab240" ? resolveCnab240Bb(row) : resolveNacha(row);
  if (!resolved.ok) return resolved;
  return { ok: true, config: { ...resolved.config, lineEnding: lineEndingFor(row, format) } };
}

/** Load and validate one profile's originator configuration. */
export async function payrollOriginatorConfig(
  orgId: string,
  paymentBankProfileId: string,
): Promise<PayrollOriginatorResult & { format?: PayRunBankFileFormat }> {
  const rows = (await db.execute<ProfileRow>(sql`
    select p.id, p.name, p.currency, f.rail, p.settings, p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${paymentBankProfileId} and p.is_active and f.is_active
  `));
  const row = rows.rows[0];
  if (!row) throw new PayrollError("payment bank profile not found or inactive");
  const format = formatForRail(row.rail);
  if (!format) {
    throw new PayrollError(
      `payment bank profile "${row.name}" originates ${row.rail}, which payroll cannot pay on`,
    );
  }
  const spec = PAYROLL_BANK_FILE_FORMATS[format];
  if (!spec.enabled) {
    throw new PayrollError(
      spec.disabledReason ?? `the ${format} payroll bank-file format is not enabled`,
    );
  }
  return { ...resolveOriginator(row, format), format };
}

// ---------------------------------------------------------------------------
// Entries: the employees' side
// ---------------------------------------------------------------------------

export interface PayRunBankFileCredit extends PayRunBankFileEntry {
  /** employee_roles.employee_number, or a stable fallback. */
  employeeNumber: string;
  /** CA: { institution, transit }. US: 9-digit ABA. SEPA: { iban, bic }. Cemtex: { bsb }. Bacs: { sortCode }. */
  routing: Record<string, string>;
  accountNumber: string;
  /** SEPA only: the validated creditor IBAN this credit will be paid to. */
  iban?: string;
  /** SEPA only: the creditor agent BIC, when the employee's bank row carries one. */
  bic?: string | null;
  /** Cemtex only: the validated creditor BSB (NNN-NNN) this credit will be paid to. */
  bsb?: string;
  /** Bacs only: the validated creditor sort code (NN-NN-NN) this credit will be paid to. */
  sortCode?: string;
  /** Zengin only: the validated 4-digit destination bank code. */
  bankCode?: string;
  /** Zengin only: the validated 3-digit destination branch code. */
  branchCode?: string;
  /** Zengin only: the validated deposit type ("1" = 普通, "2" = 当座). */
  depositType?: string;
  /** Zengin only: the half-width katakana payee name on the data record. */
  payeeKana?: string;
  /** CNAB 240 only: the validated destino address this credit will be paid to. */
  cnab240?: Cnab240CreditorAddress;
}

/** The validated destino address of one CNAB 240 credit. */
export interface Cnab240CreditorAddress {
  /** 3-digit destination bank ('001' rides forma 01; anything else rides TED forma 41). */
  bancoFavorecido: string;
  /** Normalized agência (5 digits), agência DV, conta DV, optional second DV. */
  agencia: string;
  agenciaDv: string;
  contaDv: string;
  dac: string | null;
  /** '1' CPF / '2' CNPJ with check-digit-valid inscription. */
  inscricaoTipo: "1" | "2";
  inscricaoNumero: string;
}


/**
 * The SEPA address of one payroll credit, resolved purely.
 *
 * Split out from `loadCredits` so the refusal logic is unit-testable with no
 * database: an IBAN that fails the ISO 13616 mod-97 check (or is missing
 * entirely) is a typed refusal naming the employee and the remedy, never a
 * silent drop and never a coerced account number. The BIC is optional in
 * pain.001 — but a supplied one that fails ISO 9362 is refused the same way.
 */
export function resolveSepaCreditor(
  employeeName: string,
  routing: Record<string, string>,
  accountNumber: string,
): { ok: true; iban: string; bic: string | null } | { ok: false; reason: string } {
  // Same precedence as the AP rail (run-readiness.ts): the bank row's own
  // IBAN field wins, the stored account number is the fallback.
  const raw = (routing.iban ?? accountNumber).replace(/\s/g, "");
  if (raw === "") {
    return {
      ok: false,
      reason: `${employeeName}: SEPA needs an IBAN on the employee's approved bank account — add one in Setup → Payment operations or pay this employee by cheque`,
    };
  }
  if (!isValidIban(raw)) {
    return {
      ok: false,
      reason: `${employeeName}: "${raw}" is not a valid IBAN (ISO 13616 mod-97 check failed) — correct it on the employee's approved bank account or pay this employee by cheque`,
    };
  }
  const bic = (routing.bic ?? "").trim().toUpperCase() || null;
  if (bic && !isValidBic(bic)) {
    return {
      ok: false,
      reason: `${employeeName}: BIC "${routing.bic}" is not a valid ISO 9362 BIC — correct it on the employee's approved bank account or remove it (the BIC is optional)`,
    };
  }
  return { ok: true, iban: raw.toUpperCase(), bic };
}

/**
 * The Cemtex address of one payroll credit, resolved purely.
 *
 * Split out from `loadCredits` so the refusal logic is unit-testable with no
 * database: a BSB that is not six digits (with an optional hyphen or space)
 * or an account number that is not 1–9 digits is a typed refusal naming the
 * employee and the remedy, never a silent drop and never a coerced account —
 * a coerced BSB pays a stranger. The hyphen is pure formatting and
 * canonicalizes to NNN-NNN; anything longer than nine digits cannot be
 * expressed in the 9-character field and is refused rather than truncated.
 */
export function resolveCemtexCreditor(
  employeeName: string,
  routing: Record<string, string>,
  accountNumber: string,
): { ok: true; bsb: string; accountNumber: string } | { ok: false; reason: string } {
  const bsb = normalizeBsb(routing.bsb ?? "");
  if (!bsb) {
    return {
      ok: false,
      reason: `${employeeName}: Cemtex needs a 6-digit BSB (NNN-NNN) on the employee's approved bank account — add one or pay this employee by cheque`,
    };
  }
  const normalized = normalizeCemtexAccount(accountNumber);
  if (normalized === null) {
    return {
      ok: false,
      reason: `${employeeName}: "${accountNumber}" is not a valid Australian account number (1–9 digits) — correct it on the employee's approved bank account or pay this employee by cheque`,
    };
  }
  return { ok: true, bsb, accountNumber: normalized };
}

/**
 * The Bacs address of one payroll credit, resolved purely.
 *
 * Split out from `loadCredits` so the refusal logic is unit-testable with no
 * database: a sort code that is not six digits or an account number that is
 * not eight digits is a typed refusal naming the employee and the remedy,
 * never a silent drop and never a coerced account — a coerced sort code pays
 * a stranger. Hyphens and spaces are pure formatting and canonicalize
 * (`204512` → `20-45-12`); the IBAN validator is never consulted, because a
 * UK sort code plus account number is not an IBAN. Shape only: allocation
 * validity (EISCD directory, VocaLink modulus weight tables) is the bank's,
 * not a transcription here.
 */
export function resolveBacsCreditor(
  employeeName: string,
  routing: Record<string, string>,
  accountNumber: string,
): { ok: true; sortCode: string; accountNumber: string } | { ok: false; reason: string } {
  const sortCode = normalizeSortCode(routing.sortCode ?? routing.sort_code ?? routing.sortcode ?? "");
  if (!sortCode) {
    return {
      ok: false,
      reason: `${employeeName}: Bacs needs a 6-digit sort code (NN-NN-NN) on the employee's approved bank account — add one or pay this employee by cheque`,
    };
  }
  const normalized = normalizeGbAccountNumber(accountNumber);
  if (normalized === null) {
    return {
      ok: false,
      reason: `${employeeName}: "${accountNumber}" is not a valid UK account number (8 digits) — correct it on the employee's approved bank account or pay this employee by cheque`,
    };
  }
  return { ok: true, sortCode, accountNumber: normalized };
}

/**
 * The Zengin address of one payroll credit, resolved purely.
 *
 * Split out from `loadCredits` so the refusal logic is unit-testable with no
 * database: a bank code that is not 4 digits, a branch code that is not 3
 * digits, a deposit type outside {1 = 普通, 2 = 当座}, or an account number
 * that is not 1–7 digits is a typed refusal naming the employee and the
 * remedy, never a silent drop and never a coerced account — a coerced bank
 * code pays a stranger. The IBAN validator is never consulted: a Japanese
 * bank/branch/account triple is not an IBAN.
 *
 * The payee kana name comes from the bank row (`routing.payeeKana`, with
 * `kanaName`/`accountNameKana` accepted as aliases), falling back to a
 * mechanical mapping of the employee's name. A name with no mechanical
 * kana reading — kanji — refuses with the フリガナ remedy: the reading is
 * operator knowledge, not a derivable byte string.
 */
export function resolveZenginCreditor(
  employeeName: string,
  routing: Record<string, string>,
  accountNumber: string,
): { ok: true; bankCode: string; branchCode: string; depositType: string; accountNumber: string; payeeKana: string } | { ok: false; reason: string } {
  const bankCode = normalizeBankCode(routing.bankCode ?? routing.bank_code ?? routing.bank ?? "");
  if (!bankCode) {
    return {
      ok: false,
      reason: `${employeeName}: Zengin needs a 4-digit bank code (金融機関コード) on the employee's approved bank account — add one or pay this employee by cheque`,
    };
  }
  const branchCode = normalizeBranchCode(routing.branchCode ?? routing.branch_code ?? routing.branch ?? "");
  if (!branchCode) {
    return {
      ok: false,
      reason: `${employeeName}: Zengin needs a 3-digit branch code (支店コード) on the employee's approved bank account — add one or pay this employee by cheque`,
    };
  }
  const depositType = (routing.depositType ?? routing.deposit_type ?? routing.accountType ?? "").trim();
  if (depositType !== "1" && depositType !== "2") {
    return {
      ok: false,
      reason: `${employeeName}: Zengin needs a deposit type of 1 (普通) or 2 (当座) on the employee's approved bank account — add one or pay this employee by cheque`,
    };
  }
  const normalized = normalizeZenginAccount(accountNumber);
  if (normalized === null) {
    return {
      ok: false,
      reason: `${employeeName}: "${accountNumber}" is not a valid Japanese account number (1–7 digits) — correct it on the employee's approved bank account or pay this employee by cheque`,
    };
  }
  const kanaSource = routing.payeeKana ?? routing.kanaName ?? routing.accountNameKana ?? "";
  const kana = toZenginKana((kanaSource || employeeName).trim());
  if (kana === null || kana === "") {
    return {
      ok: false,
      reason: `${employeeName}: the payee name cannot be expressed in half-width katakana — register the payee's katakana name (フリガナ) as payeeKana on the employee's approved bank account or pay this employee by cheque`,
    };
  }
  return { ok: true, bankCode, branchCode, depositType, accountNumber: normalized, payeeKana: kana };
}

/**
 * The CNAB 240 destino address of one payroll credit, resolved purely.
 *
 * Split out from `loadCredits` so the refusal logic is unit-testable with no
 * database: a bank code that is not 3 digits, an agência/conta outside the
 * fixed-width shapes, a missing check digit, or a CPF/CNPJ that fails the
 * módulo-11 check is a typed refusal naming the employee and the remedy —
 * never a silent drop and never a coerced account, because a coerced agência
 * pays a stranger. Brazilian details are agência + conta (with check
 * digits), never an IBAN: the IBAN validator is not consulted, and an IBAN
 * in these fields is refused as unshaped rather than parsed.
 */
export function resolveCnab240Creditor(
  employeeName: string,
  routing: Record<string, string>,
  accountNumber: string,
): { ok: true; address: Cnab240CreditorAddress } | { ok: false; reason: string } {
  const chequeRemedy = " — correct it on the employee's approved bank account or pay this employee by cheque";
  const banco = (routing.banco ?? routing.bankCode ?? "").trim();
  if (!isValidBancoCode(banco)) {
    return {
      ok: false,
      reason: `${employeeName}: CNAB 240 needs a 3-digit bank code on the employee's approved bank account ('001' for Banco do Brasil, the destination bank's code for a TED)${chequeRemedy}`,
    };
  }
  const agencia = normalizeAgencia(routing.agencia ?? routing.branch ?? "");
  if (!agencia) {
    return {
      ok: false,
      reason: `${employeeName}: CNAB 240 needs an agência of up to 5 digits on the employee's approved bank account${chequeRemedy}`,
    };
  }
  const agenciaDv = (routing.agenciaDv ?? routing.branchDv ?? "").trim().toUpperCase();
  if (!isValidContaDv(agenciaDv)) {
    return {
      ok: false,
      reason: `${employeeName}: CNAB 240 needs the agência check digit on the employee's approved bank account${chequeRemedy}`,
    };
  }
  const conta = normalizeContaNumero(accountNumber);
  if (!conta) {
    return {
      ok: false,
      reason: `${employeeName}: "${accountNumber}" is not a valid conta (up to 12 digits) — correct it on the employee's approved bank account or pay this employee by cheque`,
    };
  }
  const contaDv = (routing.contaDv ?? routing.accountDv ?? "").trim().toUpperCase();
  if (!isValidContaDv(contaDv)) {
    return {
      ok: false,
      reason: `${employeeName}: CNAB 240 needs the conta check digit on the employee's approved bank account${chequeRemedy}`,
    };
  }
  const dacRaw = (routing.dac ?? "").trim().toUpperCase();
  if (dacRaw !== "" && !isValidContaDv(dacRaw)) {
    return {
      ok: false,
      reason: `${employeeName}: DAC "${routing.dac}" is not a single check-digit character — correct it on the employee's approved bank account or remove it (leave blank for Banco do Brasil accounts)`,
    };
  }
  const inscricao = normalizeCpfCnpj(routing.cpfCnpj ?? routing.cpf ?? routing.cnpj ?? "");
  if (!inscricao) {
    return {
      ok: false,
      reason: `${employeeName}: CNAB 240 needs a check-digit-valid CPF (11 digits) or CNPJ (14 digits) on the employee's approved bank account — it rides Segmento B and TED confrontation checks it${chequeRemedy}`,
    };
  }
  return {
    ok: true,
    address: {
      bancoFavorecido: banco,
      agencia,
      agenciaDv,
      contaDv,
      dac: dacRaw === "" ? null : dacRaw,
      inscricaoTipo: inscricaoTipoFor(inscricao)!,
      inscricaoNumero: inscricao,
    },
  };
}

/**
 * The EFT population with the bank coordinates each credit needs.
 *
 * An employee may hold more than one approved account; payroll has no
 * split-deposit model, so exactly one is used and the choice is deterministic
 * (most recently created approved, active account). Anything ambiguous or
 * missing is a named refusal — a payroll file must never be emitted with a
 * guessed account.
 */
export async function loadCredits(
  orgId: string,
  population: PayRunBankFilePopulation,
  format: PayRunBankFileFormat,
): Promise<PayRunBankFileCredit[]> {
  if (population.entries.length === 0) {
    throw new PayrollError(
      "no employee on this pay run is paid by EFT — there is nothing to send the bank",
    );
  }
  const partyIds = population.entries.map((entry) => entry.employeePartyId);
  const rows = (await db.execute<{
      party_id: string;
      employee_number: string | null;
      routing: Record<string, string> | null;
      account_number_encrypted: string | null;
    }>(sql`
    select p.id as party_id, er.employee_number,
           b.routing, b.account_number_encrypted
      from parties p
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
      left join lateral (
        select b.routing, b.account_number_encrypted
          from party_bank_accounts b
         where b.org_id = p.org_id and b.party_id = p.id
           and b.is_active and b.approval_status = 'approved'
         order by b.created_at desc, b.id desc
         limit 1) b on true
     where p.org_id = ${orgId}
       and p.id = any(${`{${partyIds.join(",")}}`}::uuid[])
  `));
  const byParty = new Map(rows.rows.map((row) => [row.party_id, row]));

  const problems: string[] = [];
  const credits: PayRunBankFileCredit[] = [];
  for (const entry of population.entries) {
    const row = byParty.get(entry.employeePartyId);
    const routing = row?.routing ?? {};
    if (!row?.account_number_encrypted) {
      problems.push(`${entry.employeeName}: no approved bank account number`);
      continue;
    }
    const accountNumber = decryptAccountNumber(row.account_number_encrypted);
    if (format === "cpa005") {
      if (!/^\d{3}$/.test(routing.institution ?? "") || !/^\d{5}$/.test(routing.transit ?? "")) {
        problems.push(
          `${entry.employeeName}: CPA-005 needs a 3-digit institution and 5-digit transit number`,
        );
        continue;
      }
    } else if (format === "sepa") {
      // A SEPA credit is addressed by IBAN, not by account number: the IBAN
      // lives on the employee's bank row (`routing.iban`, falling back to the
      // stored account number the way the AP rail does), and a value that
      // fails the ISO 13616 mod-97 check is a named refusal — never silently
      // dropped, never coerced into a differently-numbered account.
      const resolved = resolveSepaCreditor(entry.employeeName, routing, accountNumber);
      if (!resolved.ok) {
        problems.push(resolved.reason);
        continue;
      }
      credits.push({
        ...entry,
        employeeNumber: row.employee_number?.trim() || entry.employeePartyId.slice(0, 8),
        routing,
        accountNumber,
        iban: resolved.iban,
        bic: resolved.bic,
      });
      continue;
    } else if (format === "cemtex") {
      // A Cemtex credit is addressed by BSB + account number: the BSB lives
      // on the employee's bank row (`routing.bsb`) and the account number is
      // the stored approved number. Either one unshaped is a named refusal —
      // never silently dropped, never coerced into a differently-numbered
      // account.
      const resolved = resolveCemtexCreditor(entry.employeeName, routing, accountNumber);
      if (!resolved.ok) {
        problems.push(resolved.reason);
        continue;
      }
      credits.push({
        ...entry,
        employeeNumber: row.employee_number?.trim() || entry.employeePartyId.slice(0, 8),
        routing,
        accountNumber: resolved.accountNumber,
        bsb: resolved.bsb,
      });
      continue;
    } else if (format === "bacs") {
      // A Bacs credit is addressed by sort code + account number: the sort
      // code lives on the employee's bank row (`routing.sortCode`) and the
      // account number is the stored approved number. Either one unshaped
      // is a named refusal — never silently dropped, never coerced into a
      // differently-numbered account.
      const resolved = resolveBacsCreditor(entry.employeeName, routing, accountNumber);
      if (!resolved.ok) {
        problems.push(resolved.reason);
        continue;
      }
      credits.push({
        ...entry,
        employeeNumber: row.employee_number?.trim() || entry.employeePartyId.slice(0, 8),
        routing,
        accountNumber: resolved.accountNumber,
        sortCode: resolved.sortCode,
      });
      continue;
    } else if (format === "zengin") {
      // A Zengin credit is addressed by bank code + branch code + 種目 +
      // account number, and named in half-width katakana. Any one of them
      // unshaped — or a name with no kana reading — is a named refusal:
      // never silently dropped, never coerced into a differently-numbered
      // account, never a guessed reading.
      const resolved = resolveZenginCreditor(entry.employeeName, routing, accountNumber);
      if (!resolved.ok) {
        problems.push(resolved.reason);
        continue;
      }
      credits.push({
        ...entry,
        employeeNumber: row.employee_number?.trim() || entry.employeePartyId.slice(0, 8),
        routing,
        accountNumber: resolved.accountNumber,
        bankCode: resolved.bankCode,
        branchCode: resolved.branchCode,
        depositType: resolved.depositType,
        payeeKana: resolved.payeeKana,
      });
      continue;
    } else if (format === "cnab240") {
      // A CNAB 240 credit is addressed by banco + agência + conta (with
      // check digits) plus the favorecido inscription on Segmento B —
      // never an IBAN. Anything unshaped or check-digit-invalid is a named
      // refusal, never silently dropped and never coerced into a
      // differently-numbered account.
      const resolved = resolveCnab240Creditor(entry.employeeName, routing, accountNumber);
      if (!resolved.ok) {
        problems.push(resolved.reason);
        continue;
      }
      credits.push({
        ...entry,
        employeeNumber: row.employee_number?.trim() || entry.employeePartyId.slice(0, 8),
        routing,
        accountNumber: accountNumber.replace(/\D/g, ""),
        cnab240: resolved.address,
      });
      continue;
    } else {
      const aba = routing.aba ?? routing.routingNumber ?? routing.routing ?? "";
      if (!/^\d{9}$/.test(aba)) {
        problems.push(`${entry.employeeName}: US ACH needs a 9-digit routing number`);
        continue;
      }
    }
    if (toUnits(entry.amount) % 100n !== 0n) {
      problems.push(`${entry.employeeName}: net pay ${entry.amount} is not a whole number of cents`);
      continue;
    }
    if (toUnits(entry.amount) <= 0n) {
      problems.push(`${entry.employeeName}: net pay ${entry.amount} is not positive`);
      continue;
    }
    credits.push({
      ...entry,
      employeeNumber: row.employee_number?.trim() || entry.employeePartyId.slice(0, 8),
      routing,
      accountNumber,
    });
  }
  if (problems.length > 0) {
    throw new PayrollError(`cannot build the payroll bank file: ${problems.join("; ")}`);
  }
  return credits;
}

// ---------------------------------------------------------------------------
// Trailer verification — the control total, read back out of the bytes
// ---------------------------------------------------------------------------

export interface TrailerTotals {
  /** Credit value carried by the file's own trailer record, in cents. */
  totalCents: bigint;
  /** Credit count carried by the file's own trailer record. */
  count: number;
}

/**
 * Read the control totals back out of the generated characters.
 *
 * This is the assertion the whole control turns on. Computing a total and then
 * claiming the file contains it proves nothing; a file whose trailer disagrees
 * with the ledger is the single worst outcome here, because the bank settles
 * the trailer and the books carry the ledger. So the totals are PARSED from
 * the produced bytes at fixed offsets and compared against the run.
 *
 * CPA-005 Z record: positions 47–60 total value of credit transactions (14
 * digits, cents), positions 61–68 total number of credit transactions (8).
 * NACHA File Control "9" record: positions 14–21 entry/addenda count (8),
 * positions 44–55 total credit entry dollar amount (12, cents).
 * SEPA pain.001: the GrpHdr `<NbOfTxs>` and `<CtrlSum>` the builder wrote —
 * parsed back out of the produced XML, never assumed from the inputs.
 * Cemtex file-total "7" record: positions 31–40 credit total (10, cents),
 * positions 75–80 detail-record count (6).
 * Bacs UTL1 trailer: positions 18–30 credit monetary total (13, pence),
 * positions 38–44 credit count (7). The debit total at 5–17 must equal the
 * credit total on a payroll file (one contra for all credits), so the
 * credit field alone ties to the ledger.
 * Zengin trailer "8" record: positions 2–7 detail-record count (6),
 * positions 8–19 total transfer value in yen (12). JPY has no minor unit,
 * so the parsed yen total is the file's minor-unit total directly.
 */
export function readTrailerTotals(format: PayRunBankFileFormat, content: string): TrailerTotals {
  // Split on either terminator: the terminator is per-institution and never
  // part of the record, so the parse must not depend on which one was written.
  const records = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (format === "cpa005") {
    const trailer = records[records.length - 1];
    if (!trailer || trailer[0] !== "Z" || trailer.length !== 1464) {
      throw new PayrollError("generated CPA-005 file has no readable Z trailer record");
    }
    return {
      totalCents: BigInt(trailer.slice(46, 60)),
      count: Number(trailer.slice(60, 68)),
    };
  }
  if (format === "sepa") {
    // GrpHdr carries the file's own totals; the FIRST NbOfTxs/CtrlSum in the
    // document is the header's (each CdtTrfTxInf carries amounts but no
    // counts). CtrlSum is exact 2dp euros, so whole cents by construction —
    // and the render refuses sub-cent credits before writing, so the parse
    // below cannot hide a fraction the ledger still carries.
    const count = content.match(/<NbOfTxs>(\d+)<\/NbOfTxs>/);
    const sum = content.match(/<CtrlSum>(\d+\.\d{2})<\/CtrlSum>/);
    if (!count || !sum) {
      throw new PayrollError("generated SEPA file has no readable GrpHdr totals");
    }
    return {
      totalCents: toUnits(sum[1]!) / 100n,
      count: Number(count[1]),
    };
  }
  const trailer = records.find((line) => line[0] === "9" && !/^9{94}$/.test(line));
  if (format === "cemtex") {
    // The file-total "7" record is the LAST record; the credit total sits at
    // positions 31–40 (slice 30–40) and the detail count at 75–80 (slice
    // 74–80). The net at 21–30 must equal the credit total on a payroll file
    // (no debits), so the credit field alone ties to the ledger.
    const last = records[records.length - 1];
    if (!last || last[0] !== "7" || last.length !== 120) {
      throw new PayrollError("generated Cemtex file has no readable file-total record");
    }
    return {
      totalCents: BigInt(last.slice(30, 40)),
      count: Number(last.slice(74, 80)),
    };
  }
  if (format === "cnab240") {
    // Every record is 240 chars; the value tie reads the P007 somatória at
    // positions 24–41 (slice 23–41) of each tipo-5 trailer de lote, and the
    // count reads the Segmento A records themselves (tipo '3', 'A' at
    // position 14). The arquivo trailer is the LAST record and must be tipo
    // 9 / lote 9999 — asserted so a truncated file cannot pass.
    const last = records[records.length - 1];
    if (!last || last[7] !== "9" || last.slice(3, 7) !== "9999" || last.length !== 240) {
      throw new PayrollError("generated CNAB 240 file has no readable trailer de arquivo record");
    }
    let totalCents = 0n;
    let count = 0;
    for (const line of records) {
      if (line.length !== 240) {
        throw new PayrollError(`payroll bank file record is ${line.length} characters, not 240`);
      }
      if (line[7] === "5") {
        const field = line.slice(23, 41);
        if (!/^\d{18}$/.test(field)) {
          throw new PayrollError("generated CNAB 240 trailer de lote has no readable somatória");
        }
        totalCents += BigInt(field);
      }
      if (line[7] === "3" && line[13] === "A") count += 1;
    }
    if (count === 0) throw new PayrollError("generated CNAB 240 file has no Segmento A records");
    return { totalCents, count };
  }
  if (format === "zengin") {
    // The trailer "8" record is the SECOND-TO-LAST record (the end "9"
    // record closes the file); the detail count sits at positions 2–7
    // (slice 1–7) and the yen total at positions 8–19 (slice 7–19).
    const last = records[records.length - 1];
    const trailer8 = records[records.length - 2];
    if (!last || last[0] !== "9" || last.length !== 120) {
      throw new PayrollError("generated Zengin file has no readable end record");
    }
    if (!trailer8 || trailer8[0] !== "8" || trailer8.length !== 120) {
      throw new PayrollError("generated Zengin file has no readable trailer record");
    }
    return {
      totalCents: BigInt(trailer8.slice(7, 19)),
      count: Number(trailer8.slice(1, 7)),
    };
  }
  if (format === "bacs") {
    // The UTL1 trailer is the LAST record; the credit monetary total sits at
    // positions 18–30 (slice 17–30) and the credit count at 38–44 (slice
    // 37–44). The debit total at 5–17 must equal it on a payroll file (one
    // debit contra balancing all credits) — asserted by the builder, tied to
    // the ledger here through the credit field.
    const last = records[records.length - 1];
    if (!last || last.slice(0, 4) !== "UTL1" || last.length !== 80) {
      throw new PayrollError("generated Bacs file has no readable UTL1 trailer record");
    }
    return {
      totalCents: BigInt(last.slice(17, 30)),
      count: Number(last.slice(37, 44)),
    };
  }
  if (!trailer || trailer.length !== 94) {
    throw new PayrollError("generated NACHA file has no readable file-control record");
  }
  return {
    totalCents: BigInt(trailer.slice(43, 55)),
    count: Number(trailer.slice(13, 21)),
  };
}

/**
 * Apply the tenant's record terminator and assert every record is still its
 * exact fixed width. A terminator that leaked into a record, or a record that
 * came out the wrong length, means every field after it has shifted.
 *
 * Fixed-width rails only: a pain.001 document is length-delimited by markup,
 * not by offsets, so there is no width to assert and the builder's own bytes
 * pass through untouched.
 */
function applyLineEnding(
  content: string,
  lineEnding: "lf" | "crlf",
  recordLength: number | null,
): string {
  if (recordLength == null) return content;
  const records = content.split(/\r?\n/).filter((line) => line.length > 0);
  for (const record of records) {
    if (record.length !== recordLength) {
      throw new PayrollError(
        `payroll bank file record is ${record.length} characters, not ${recordLength}`,
      );
    }
  }
  const terminator = lineEnding === "crlf" ? "\r\n" : "\n";
  return records.join(terminator) + terminator;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface PayRunBankFileBuildInput {
  orgId: string;
  documentId: string;
  format?: PayRunBankFileFormat;
  /** Resolved tenant originator configuration — never defaulted here. */
  originator: PayrollOriginatorConfig;
  /** CPA-005 file creation number (1–9999), allocated by the artifact module. */
  fileCreationNumber?: number;
  /** NACHA file ID modifier (A–Z, 0–9), allocated by the artifact module. */
  fileIdModifier?: string;
  /**
   * SEPA message identification (MsgId/PmtInfId), allocated by the artifact
   * module from the same number sequence. The bank deduplicates on it, so it
   * must be unique per file — never re-derived at download time.
   */
  messageId?: string;
  /**
   * Bacs VOL1 serial (6 chars), allocated by the artifact module from the
   * same number sequence. Bacs validates serials against duplicates, so it
   * must be unique per file — never re-derived at download time.
   */
  bacsVolSerial?: string;
  /** Bacs UHL1 file number (3 digits), allocated by the artifact module. */
  bacsFileNumber?: string;
  /**
   * CNAB 240 NSA (header arquivo 158–163, 6 digits), allocated by the
   * artifact module from the same number sequence. The bank sequences files
   * on it, so it must be unique per file — never re-derived at download time.
   */
  cnabNsa?: string;
  /** The date the money must be in employees' accounts (the run's pay date). */
  fundsDate: string;
  /** File creation instant. Explicit so a golden test is reproducible. */
  createdAt: Date;
}

/** Everything the renderer needs, read from the database exactly once. */
export interface PayRunBankFileInputs {
  format: PayRunBankFileFormat;
  population: PayRunBankFilePopulation;
  credits: PayRunBankFileCredit[];
}

/**
 * Read the run's side of the file (population + bank coordinates).
 *
 * Split out from the render so the artifact lifecycle can do every database
 * read BEFORE it opens the transaction that locks the run, allocates the
 * bank-facing file number, and freezes the bytes — the number has to be inside
 * the characters it numbers, so the render must be able to run with no I/O.
 */
export async function preparePayRunBankFile(
  orgId: string,
  documentId: string,
  format: PayRunBankFileFormat,
): Promise<PayRunBankFileInputs> {
  const population = await payRunBankFilePopulation(orgId, documentId);
  const credits = await loadCredits(orgId, population, format);
  return { format, population, credits };
}

export interface PayRunBankFileResult {
  format: PayRunBankFileFormat;
  content: string;
  contentType: string;
  extension: string;
  currency: string;
  entries: PayRunBankFileCredit[];
  /** Ledger-side total of the EFT population (numeric(19,4) string). */
  total: string;
  excludedCheque: ChequeExclusion[];
  excludedTotal: string;
  /** Totals parsed back out of the produced characters. */
  trailer: TrailerTotals;
  /**
   * The exact bytes to store and hand to the bank, when the bank's encoding
   * is not UTF-8. Zengin files are Shift_JIS (`encodeZenginFile` over the
   * logical content); every other rail stores the UTF-8 bytes of `content`
   * and leaves this null.
   */
  contentBytes: Buffer | null;
}

/** Local date (YYYY-MM-DD) → Date at local midnight, matching the AP writers. */
function localDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

/**
 * Render the file and verify it. Pure: no database, no clock, no randomness —
 * the same inputs always produce the same characters, which is what makes the
 * stored artifact reproducible evidence and the golden tests meaningful.
 */
export function renderPayRunBankFile(
  inputs: PayRunBankFileInputs,
  input: PayRunBankFileBuildInput,
): PayRunBankFileResult {
  const format = inputs.format;
  const spec = PAYROLL_BANK_FILE_FORMATS[format];
  if (!spec) throw new PayrollError(`unknown payroll bank-file format "${format}"`);
  if (!spec.enabled) {
    throw new PayrollError(spec.disabledReason ?? `the ${format} payroll bank-file format is not enabled`);
  }
  if (input.originator.format !== format) {
    throw new PayrollError(
      `payment bank profile "${input.originator.profileName}" originates ${input.originator.format}, not ${format}`,
    );
  }
  const { population, credits } = inputs;

  // The population's own total must agree with the sum of what will actually
  // be written. These are the same numbers by construction; asserting it costs
  // nothing and catches a future filter that drops a credit.
  const entriesTotal = sum(credits.map((credit) => credit.amount));
  if (cmp(entriesTotal, population.total) !== 0) {
    throw new PayrollError(
      `payroll bank file entries total ${entriesTotal} but the EFT population is ${population.total}`,
    );
  }

  // Whole cents, checked HERE and not only at load time.
  //
  // The ledger carries numeric(19,4); a bank file has two implied decimals. A
  // half-cent net pay therefore truncates on its way into the amount field —
  // and the trailer check below cannot see it, because the trailer truncates
  // the same fraction off the same total and the two agree on a number that
  // is not what the employee is owed. So sub-cent credits are refused before a
  // single character is written, on the pure path as well as the loaded one.
  for (const credit of credits) {
    const units = toUnits(credit.amount);
    if (units <= 0n) {
      throw new PayrollError(
        `payroll bank file refuses ${credit.employeeName}: net pay ${credit.amount} is not positive`,
      );
    }
    if (units % 100n !== 0n) {
      throw new PayrollError(
        `payroll bank file refuses ${credit.employeeName}: net pay ${credit.amount} is not a whole ` +
          "number of cents and a bank file cannot express a fraction of one",
      );
    }
  }
  if (toUnits(population.total) % 100n !== 0n) {
    throw new PayrollError(
      `payroll bank file control total ${population.total} is not a whole number of cents`,
    );
  }

  const content = applyLineEnding(
    format === "cpa005"
      ? buildCpa005Payroll(input, credits)
      : format === "sepa"
        ? buildSepaPayroll(input, credits)
        : format === "cemtex"
          ? buildCemtexPayroll(input, credits)
          : format === "bacs"
            ? buildBacsPayroll(input, credits)
            : format === "zengin"
              ? buildZenginPayroll(input, credits)
              : buildNachaPayroll(input, credits),
    input.originator.lineEnding,
    // Mixed widths (80-char labels, 100-char data) are asserted per record
    // by the Bacs builder itself; applyLineEnding only applies the
    // terminator for that rail. Zengin is 120; CNAB 240 is 240.
    format === "cpa005" ? 1464 : format === "nacha" ? 94 : format === "cemtex" || format === "zengin" ? 120 : null,
  );

  // Everything below is read back out of the produced characters.
  const trailer = readTrailerTotals(format, content);
  // JPY has no minor unit: the Zengin trailer carries whole yen, so the
  // ledger total scales by 10,000 (numeric(19,4) units), not by 100.
  const expectedMinor =
    format === "zengin" ? toUnits(population.total) / 10000n : toUnits(population.total) / 100n;
  const unitWord = format === "zengin" ? "yen" : "cents";
  if (trailer.totalCents !== expectedMinor) {
    throw new PayrollError(
      `payroll bank file trailer total ${trailer.totalCents} ${unitWord} does not equal the run's EFT net pay ` +
        `${formatMoney(population.total, 2)} (${expectedMinor} ${unitWord})`,
    );
  }
  if (trailer.count !== credits.length) {
    throw new PayrollError(
      `payroll bank file trailer counts ${trailer.count} credits but the run has ${credits.length}`,
    );
  }

  return {
    format,
    content,
    contentType: spec.contentType,
    extension: spec.extension,
    currency: spec.currency,
    entries: credits,
    total: population.total,
    excludedCheque: population.excludedCheque,
    excludedTotal: population.excludedTotal,
    trailer,
    contentBytes: format === "zengin" ? encodeZenginFile(content) : null,
  };
}

function buildCpa005Payroll(
  input: PayRunBankFileBuildInput,
  credits: PayRunBankFileCredit[],
): string {
  const settings = input.originator.cpa005;
  if (!settings) throw new PayrollError("CPA-005 originator configuration is missing");
  if (input.fileCreationNumber == null) {
    throw new PayrollError("CPA-005 requires an allocated file creation number");
  }
  const fundsDate = localDate(input.fundsDate);
  const payments: Cpa005Payment[] = credits.map((credit) => ({
    // Cents via money.ts bigint units — never a float division.
    amountCents: toUnits(credit.amount) / 100n,
    fundsDate,
    institution: credit.routing.institution!,
    transit: credit.routing.transit!,
    accountNumber: credit.accountNumber,
    payeeName: credit.employeeName,
    // Originator's cross-reference (19 chars) — what the employer sees on the
    // bank's reporting. The employee number keeps it reconcilable to payroll.
    crossReference: `PAY ${credit.employeeNumber}`.slice(0, 19),
  }));
  return buildCpa005File({
    settings,
    fileCreationNumber: input.fileCreationNumber,
    fileCreationDate: input.createdAt,
    payments,
  });
}

/** Local datetime `YYYY-MM-DDTHH:mm:ss`, matching the AP SEPA writer's `${today}T00:00:00` shape. */
function localDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Render payroll credits through the SHARED AP pain.001 builder
 * (`buildSepaFile`, engine/src/payments/rail-formatters.ts) — the same
 * function, the same IBAN mod-97 gate, the same XML. Payroll only maps its
 * own population onto the builder's generic payment rows; there is no second
 * SEPA implementation here.
 */
function buildSepaPayroll(
  input: PayRunBankFileBuildInput,
  credits: PayRunBankFileCredit[],
): string {
  const settings = input.originator.sepa;
  if (!settings) throw new PayrollError("SEPA originator configuration is missing");
  if (!input.messageId) {
    throw new PayrollError("SEPA requires an allocated message identification");
  }
  return buildSepaFile({
    settings,
    messageId: input.messageId,
    creationDateTime: localDateTime(input.createdAt),
    executionDate: input.fundsDate,
    payments: credits.map((credit) => {
      if (!credit.iban) {
        throw new PayrollError(
          `payroll bank file refuses ${credit.employeeName}: no validated IBAN was resolved for this credit`,
        );
      }
      return {
        // End-to-end id (≤35 chars) — what the employer reconciles the bank
        // reporting by. The message id keeps it unique per file.
        endToEndId: `${input.messageId}-${credit.employeeNumber}`.slice(0, 35),
        amount: credit.amount,
        creditorName: credit.employeeName,
        creditorIban: credit.iban,
        creditorBic: credit.bic,
        // Unstructured remittance (≤140) — what the employee sees. Mirrors
        // the CPA-005 cross-reference `PAY ${employeeNumber}`.
        remittance: `PAY ${credit.employeeNumber}`,
      };
    }),
  });
}

/**
 * Render payroll credits through the SHARED AP Cemtex builder
 * (`buildCemtexFile`, engine/src/payments/rail-formatters.ts) — the same
 * function, the same BSB shape gate, the same 120-character records. Payroll
 * only maps its own population onto the builder's generic payment rows;
 * there is no second Cemtex implementation here.
 */
function buildCemtexPayroll(
  input: PayRunBankFileBuildInput,
  credits: PayRunBankFileCredit[],
): string {
  const settings = input.originator.cemtex;
  if (!settings) throw new PayrollError("Cemtex originator configuration is missing");
  const payments: CemtexPayment[] = credits.map((credit) => {
    if (!credit.bsb) {
      throw new PayrollError(
        `payroll bank file refuses ${credit.employeeName}: no validated BSB was resolved for this credit`,
      );
    }
    return {
      // Cents via money.ts bigint units — never a float division.
      amountCents: toUnits(credit.amount) / 100n,
      bsb: credit.bsb,
      accountNumber: credit.accountNumber,
      accountTitle: credit.employeeName.slice(0, 32),
      // Lodgement reference (18 chars) — what the employee sees on their
      // statement. Mirrors the CPA-005 cross-reference `PAY ${employeeNumber}`.
      lodgementReference: `PAY ${credit.employeeNumber}`.slice(0, 18),
    };
  });
  return buildCemtexFile({
    settings,
    // The release date: the day the money must be in employees' accounts —
    // the run's pay date, the same date the other rails settle on.
    processingDate: localDate(input.fundsDate),
    payments,
  });
}

/**
 * Render payroll credits through the SHARED AP Bacs builder (`buildBacsFile`,
 * engine/src/payments/rail-formatters.ts) — the same function, the same
 * sort-code shape gate, the same 100-character credit records. Payroll only
 * maps its own population onto the builder's generic payment rows; there is
 * no second Standard 18 implementation here.
 */
function buildBacsPayroll(
  input: PayRunBankFileBuildInput,
  credits: PayRunBankFileCredit[],
): string {
  const settings = input.originator.bacs;
  if (!settings) throw new PayrollError("Bacs originator configuration is missing");
  if (!input.bacsVolSerial) {
    throw new PayrollError("Bacs requires an allocated VOL1 serial number");
  }
  if (!input.bacsFileNumber) {
    throw new PayrollError("Bacs requires an allocated file number");
  }
  const payments: BacsPayment[] = credits.map((credit) => {
    if (!credit.sortCode) {
      throw new PayrollError(
        `payroll bank file refuses ${credit.employeeName}: no validated sort code was resolved for this credit`,
      );
    }
    return {
      // Pence via money.ts bigint units — never a float division.
      amountCents: toUnits(credit.amount) / 100n,
      sortCode: credit.sortCode,
      accountNumber: credit.accountNumber,
      accountName: credit.employeeName,
      // Service user's reference (18 chars) — what the employee sees on
      // their statement. Mirrors the CPA-005 cross-reference
      // `PAY ${employeeNumber}`.
      reference: `PAY ${credit.employeeNumber}`.slice(0, 18),
    };
  });
  return buildBacsFile({
    settings,
    // The processing date: the day the money must be in employees' accounts
    // — the run's pay date, the same date the other rails settle on. It must
    // be a valid Bacs processing day from the bank calendar, which is not
    // transcribed here: an invalid day is the bank's loud rejection.
    processingDate: localDate(input.fundsDate),
    creationDate: input.createdAt,
    volSerial: input.bacsVolSerial,
    fileNumber: input.bacsFileNumber,
    payments,
  });
}

/**
 * Render payroll credits through the SHARED AP Zengin builder
 * (`buildZenginFile`, engine/src/payments/rail-formatters.ts) — the same
 * function, the same bank/branch shape gates, the same 120-byte records.
 * Payroll only maps its own population onto the builder's generic payment
 * rows; there is no second Zengin implementation here.
 *
 * JPY has no minor unit: a net pay with a fractional yen is refused here —
 * the generic render gate above only polices sub-cent fractions, which a
 * whole-cent fractional yen (e.g. 100.50) passes. Rounding would change what
 * the employee is owed.
 */
function buildZenginPayroll(
  input: PayRunBankFileBuildInput,
  credits: PayRunBankFileCredit[],
): string {
  const settings = input.originator.zengin;
  if (!settings) throw new PayrollError("Zengin originator configuration is missing");
  const payments: ZenginPayment[] = credits.map((credit) => {
    if (!credit.bankCode || !credit.branchCode || !credit.depositType || !credit.payeeKana) {
      throw new PayrollError(
        `payroll bank file refuses ${credit.employeeName}: no validated Zengin coordinates were resolved for this credit`,
      );
    }
    const units = toUnits(credit.amount);
    if (units % 10000n !== 0n) {
      throw new PayrollError(
        `payroll bank file refuses ${credit.employeeName}: net pay ${credit.amount} is not a whole ` +
          "number of yen and a Zengin file cannot express a fraction of one",
      );
    }
    return {
      // Yen via money.ts bigint units — never a float division.
      amountYen: units / 10000n,
      bankCode: credit.bankCode,
      branchCode: credit.branchCode,
      depositType: credit.depositType,
      accountNumber: credit.accountNumber,
      // Already half-width katakana from `resolveZenginCreditor`; the
      // builder re-maps idempotently and refuses defensively.
      payeeName: credit.payeeKana,
      // 社員番号 (10 chars) — what the employer reconciles the bank
      // reporting by. Mirrors the CPA-005 cross-reference.
      employeeNumber: credit.employeeNumber,
    };
  });
  return buildZenginFile({
    settings,
    // The transfer date: the day the salary must move — the run's pay date,
    // the same date the other rails settle on (emitted as MMDD).
    transferDate: localDate(input.fundsDate),
    payments,
  });
}

/**
 * Render payroll credits through the SHARED AP CNAB 240 builder
 * (`buildCnab240BbFile`, engine/src/payments/rail-formatters.ts) — the same
 * function, the same agência/conta shape gates, the same 240-character
 * records. Payroll only maps its own population onto the builder's generic
 * payment rows; there is no second CNAB implementation here.
 */
function buildCnab240Payroll(
  input: PayRunBankFileBuildInput,
  credits: PayRunBankFileCredit[],
): string {
  const settings = input.originator.cnab240bb;
  if (!settings) throw new PayrollError("CNAB 240 originator configuration is missing");
  if (!input.cnabNsa) {
    throw new PayrollError("CNAB 240 requires an allocated NSA sequence number");
  }
  const payments: Cnab240BbPayment[] = credits.map((credit) => {
    if (!credit.cnab240) {
      throw new PayrollError(
        `payroll bank file refuses ${credit.employeeName}: no validated destino address was resolved for this credit`,
      );
    }
    return {
      // Centavos via money.ts bigint units — never a float division.
      amountCents: toUnits(credit.amount) / 100n,
      bancoFavorecido: credit.cnab240.bancoFavorecido,
      agencia: credit.cnab240.agencia,
      agenciaDv: credit.cnab240.agenciaDv,
      conta: credit.accountNumber,
      contaDv: credit.cnab240.contaDv,
      dac: credit.cnab240.dac,
      favorecidoNome: credit.employeeName,
      inscricaoTipo: credit.cnab240.inscricaoTipo,
      inscricaoNumero: credit.cnab240.inscricaoNumero,
      // Seu número (G064, 20 chars) — what the employer reconciles the
      // bank's return by. Mirrors the CPA-005 cross-reference
      // `PAY ${employeeNumber}`; unique per employee per file.
      seuNumero: `PAY ${credit.employeeNumber}`.slice(0, 20),
    };
  });
  return buildCnab240BbFile({
    settings,
    nsa: input.cnabNsa,
    creationDate: input.createdAt,
    // The payment date: the day the money must be in employees' accounts —
    // the run's pay date, the same date the other rails settle on.
    paymentDate: localDate(input.fundsDate),
    payments,
  });
}

function buildNachaPayroll(
  input: PayRunBankFileBuildInput,
  credits: PayRunBankFileCredit[],
): string {
  const settings = input.originator.nacha;
  if (!settings) throw new PayrollError("NACHA originator configuration is missing");
  if (!input.fileIdModifier) {
    throw new PayrollError("NACHA requires an allocated file ID modifier");
  }
  const entries: NachaEntry[] = credits.map((credit) => ({
    // 22 = demand (checking) credit, 32 = savings credit.
    transactionCode: credit.routing.accountType === "savings" ? "32" : "22",
    routingNumber: credit.routing.aba ?? credit.routing.routingNumber ?? credit.routing.routing!,
    accountNumber: credit.accountNumber,
    amountCents: toUnits(credit.amount) / 100n,
    individualId: credit.employeeNumber.slice(0, 15),
    individualName: credit.employeeName,
  }));
  return buildNachaFile({
    settings,
    effectiveDate: localDate(input.fundsDate),
    creationDate: input.createdAt,
    fileIdModifier: input.fileIdModifier,
    entries,
  });
}
