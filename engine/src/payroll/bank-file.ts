import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, formatMoney, sum, toUnits } from "../money/money.ts";
import { buildCpa005File, type Cpa005Payment } from "../payments/rail-cpa005.ts";
import { buildNachaFile, type NachaEntry, type NachaSettings } from "../payments/rail-nacha.ts";
import { buildSepaFile, validateSepaSettings, type SepaSettings } from "../payments/rail-sepa.ts";
import { buildCemtexFile, normalizeBsb, normalizeCemtexAccount, validateCemtexSettings, type CemtexPayment, type CemtexSettings } from "../payments/rail-cemtex.ts";
import { decryptAccountNumber, isValidBic, isValidIban, type EftSettings } from "../payments/rail-settings.ts";
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

export type PayRunBankFileFormat = "cpa005" | "nacha" | "sepa" | "cemtex";

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
 *   COUNT — see below and `itemTraceNumber` in engine/src/payments/rail-cpa005.ts.
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
 * the transaction is REJECTED. `buildCpa005File` (engine/src/payments/rail-cpa005.ts)
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
 * shared AP builder (`buildSepaFile`, engine/src/payments/rail-sepa.ts)
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
 * (`buildCemtexFile`, engine/src/payments/rail-cemtex.ts) — payroll maps
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
 * All four writers are the audited AP ones in engine/src/payments/rail-cpa005.ts,
 * engine/src/payments/rail-nacha.ts, engine/src/payments/rail-sepa.ts and
 * engine/src/payments/rail-cemtex.ts
 * (`buildCpa005File`, `buildNachaFile`, `buildSepaFile`, `buildCemtexFile`) — payroll deliberately does not fork a
 * second implementation of a fixed-width money format.
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

/** CPA-005 is CRLF-terminated per the bank implementation guides; NACHA is per-ODFI; SEPA pain.001 is LF-terminated XML; Cemtex files are CR/LF-delimited per the annotated sample. */
function lineEndingFor(row: ProfileRow, format: PayRunBankFileFormat): "lf" | "crlf" {
  // A switch, not a Record of constants: the NACHA arm reads per-profile
  // settings, so there is no single value to tabulate. The never-binding in
  // default (not just a throw) is what fails tsc when the union grows
  // without a new case; the throw itself names the format for the
  // JavaScript caller and the already-persisted row the type system cannot
  // police.
  switch (format) {
    case "cpa005":
      return "crlf";
    case "sepa":
      return "lf";
    case "cemtex":
      return "crlf";
    case "nacha":
      return String(row.settings?.lineEnding ?? "").toLowerCase() === "crlf" ? "crlf" : "lf";
    default: {
      const _exhaustive: never = format;
      throw new PayrollError(`unknown payroll bank-file format "${String(_exhaustive)}"`);
    }
  }
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
 * Originator validation per format — a lookup, not a chain. The Record type
 * refuses a union member with no resolver at build time, instead of
 * validating it as another rail's profile at generation time.
 */
const PAYROLL_BANK_FILE_ORIGINATOR_RESOLVERS: Record<
  PayRunBankFileFormat,
  (row: ProfileRow) => PayrollOriginatorResult
> = {
  cpa005: resolveCpa005,
  nacha: resolveNacha,
  sepa: resolveSepa,
  cemtex: resolveCemtex,
};

function resolveOriginator(row: ProfileRow, format: PayRunBankFileFormat): PayrollOriginatorResult {
  // Branch on the profile's rail-mapped format, never on a country: packs
  // declare which rail they settle on and this resolver only reads it.
  const resolve = PAYROLL_BANK_FILE_ORIGINATOR_RESOLVERS[format];
  // Unreachable from TypeScript (the Record is total; noUncheckedIndexedAccess
  // forces the check anyway) — the refusal is for the JavaScript caller and
  // the already-persisted row the type system cannot police.
  if (!resolve) throw new PayrollError(`unknown payroll bank-file format "${format}"`);
  const resolved = resolve(row);
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
  /** CA: { institution, transit }. US: 9-digit ABA. SEPA: { iban, bic }. Cemtex: { bsb }. */
  routing: Record<string, string>;
  accountNumber: string;
  /** SEPA only: the validated creditor IBAN this credit will be paid to. */
  iban?: string;
  /** SEPA only: the creditor agent BIC, when the employee's bank row carries one. */
  bic?: string | null;
  /** Cemtex only: the validated creditor BSB (NNN-NNN) this credit will be paid to. */
  bsb?: string;
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
    // Exhaustive over the union: each format states how its credits are
    // addressed, and a format with no case fails tsc at the never-binding
    // below instead of being validated as another rail's account. A switch,
    // not a Record: the SEPA/Cemtex arms resolve-and-push inside this loop's
    // shared tail, which has no single value to tabulate. The default's
    // throw names the format for the JavaScript caller and the
    // already-persisted row the type system cannot police.
    switch (format) {
      case "cpa005": {
        if (!/^\d{3}$/.test(routing.institution ?? "") || !/^\d{5}$/.test(routing.transit ?? "")) {
          problems.push(
            `${entry.employeeName}: CPA-005 needs a 3-digit institution and 5-digit transit number`,
          );
          continue;
        }
        break;
      }
      case "sepa": {
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
      }
      case "cemtex": {
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
      }
      case "nacha": {
        const aba = routing.aba ?? routing.routingNumber ?? routing.routing ?? "";
        if (!/^\d{9}$/.test(aba)) {
          problems.push(`${entry.employeeName}: US ACH needs a 9-digit routing number`);
          continue;
        }
        break;
      }
      default: {
        const _exhaustive: never = format;
        throw new PayrollError(`unknown payroll bank-file format "${String(_exhaustive)}"`);
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

/** The produced characters, in both shapes the trailer readers need. */
interface BankFileTrailerSource {
  /** Non-empty records, split on either terminator. */
  records: string[];
  /** The raw produced characters (for the markup-delimited rails). */
  content: string;
}

/**
 * CPA-005 Z record: positions 47–60 total value of credit transactions (14
 * digits, cents), positions 61–68 total number of credit transactions (8).
 */
function readCpa005Trailer({ records }: BankFileTrailerSource): TrailerTotals {
  const trailer = records[records.length - 1];
  if (!trailer || trailer[0] !== "Z" || trailer.length !== 1464) {
    throw new PayrollError("generated CPA-005 file has no readable Z trailer record");
  }
  return {
    totalCents: BigInt(trailer.slice(46, 60)),
    count: Number(trailer.slice(60, 68)),
  };
}

/**
 * NACHA File Control "9" record: positions 14–21 entry/addenda count (8),
 * positions 44–55 total credit entry dollar amount (12, cents).
 */
function readNachaTrailer({ records }: BankFileTrailerSource): TrailerTotals {
  const trailer = records.find((line) => line[0] === "9" && !/^9{94}$/.test(line));
  if (!trailer || trailer.length !== 94) {
    throw new PayrollError("generated NACHA file has no readable file-control record");
  }
  return {
    totalCents: BigInt(trailer.slice(43, 55)),
    count: Number(trailer.slice(13, 21)),
  };
}

/**
 * SEPA pain.001: the GrpHdr `<NbOfTxs>` and `<CtrlSum>` the builder wrote —
 * parsed back out of the produced XML, never assumed from the inputs.
 */
function readSepaTrailer({ content }: BankFileTrailerSource): TrailerTotals {
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

/**
 * Cemtex file-total "7" record: positions 31–40 credit total (10, cents),
 * positions 75–80 detail-record count (6).
 */
function readCemtexTrailer({ records }: BankFileTrailerSource): TrailerTotals {
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

/**
 * The trailer reader per format — a lookup, not a chain. The Record type
 * refuses a union member with no reader at build time, instead of parsing
 * its bytes as another rail's trailer at generation time. A pending rail is
 * wired by adding its reader plus one line here.
 */
const PAYROLL_BANK_FILE_TRAILER_READERS: Record<
  PayRunBankFileFormat,
  (source: BankFileTrailerSource) => TrailerTotals
> = {
  cpa005: readCpa005Trailer,
  nacha: readNachaTrailer,
  sepa: readSepaTrailer,
  cemtex: readCemtexTrailer,
};

/**
 * Read the control totals back out of the generated characters.
 *
 * This is the assertion the whole control turns on. Computing a total and then
 * claiming the file contains it proves nothing; a file whose trailer disagrees
 * with the ledger is the single worst outcome here, because the bank settles
 * the trailer and the books carry the ledger. So the totals are PARSED from
 * the produced bytes at fixed offsets and compared against the run.
 */
export function readTrailerTotals(format: PayRunBankFileFormat, content: string): TrailerTotals {
  // Split on either terminator: the terminator is per-institution and never
  // part of the record, so the parse must not depend on which one was written.
  const records = content.split(/\r?\n/).filter((line) => line.length > 0);
  const read = PAYROLL_BANK_FILE_TRAILER_READERS[format];
  // Unreachable from TypeScript (the Record is total; noUncheckedIndexedAccess
  // forces the check anyway) — the refusal names the format for the
  // JavaScript caller and the already-persisted row the type system cannot
  // police, even when the bytes fed in are another rail's well-formed file.
  if (!read) throw new PayrollError(`unknown payroll bank-file format "${format}"`);
  return read({ records, content });
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
}

/** Local date (YYYY-MM-DD) → Date at local midnight, matching the AP writers. */
function localDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

/**
 * The per-format renderer — a lookup, not a chain. The Record type refuses a
 * union member with no builder at build time, instead of handing its credits
 * to another rail's writer at generation time. A pending rail (bacs, zengin,
 * cnab240, giro, elixir0) is wired by adding one line here once its builder
 * exists in this tree — never by extending a ternary default.
 */
const PAYROLL_BANK_FILE_BUILDERS: Record<
  PayRunBankFileFormat,
  (input: PayRunBankFileBuildInput, credits: PayRunBankFileCredit[]) => string
> = {
  cpa005: buildCpa005Payroll,
  nacha: buildNachaPayroll,
  sepa: buildSepaPayroll,
  cemtex: buildCemtexPayroll,
};

/**
 * Fixed record width each rail's characters must hold, or null when the rail
 * is length-delimited rather than offset-delimited. SEPA pain.001 is XML, so
 * null is the DECLARED answer for that reason — not a chain's leftover
 * default. A future delimited rail (Elixir-0 is comma-separated, not
 * fixed-width) declares null here for the same stated reason.
 */
export const PAYROLL_BANK_FILE_RECORD_LENGTHS: Record<PayRunBankFileFormat, number | null> = {
  cpa005: 1464,
  nacha: 94,
  sepa: null,
  cemtex: 120,
};

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

  // Lookups, not chains: a format the Records do not wire fails tsc at the
  // Record literal instead of rendering another rail's file.
  const build = PAYROLL_BANK_FILE_BUILDERS[format];
  // Unreachable from TypeScript (the Record is total; noUncheckedIndexedAccess
  // forces the check anyway) — the refusal names the format for the
  // JavaScript caller and the already-persisted row the type system cannot
  // police.
  if (!build) throw new PayrollError(`unknown payroll bank-file format "${format}"`);
  const content = applyLineEnding(
    build(input, credits),
    input.originator.lineEnding,
    // The builder guard above already refused the unknown format; the
    // `?? null` only satisfies noUncheckedIndexedAccess, which types every
    // indexed access `T | undefined` even over a total Record.
    PAYROLL_BANK_FILE_RECORD_LENGTHS[format] ?? null,
  );

  // Everything below is read back out of the produced characters.
  const trailer = readTrailerTotals(format, content);
  const expectedCents = toUnits(population.total) / 100n;
  if (trailer.totalCents !== expectedCents) {
    throw new PayrollError(
      `payroll bank file trailer total ${trailer.totalCents} cents does not equal the run's EFT net pay ` +
        `${formatMoney(population.total, 2)} (${expectedCents} cents)`,
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
 * (`buildSepaFile`, engine/src/payments/rail-sepa.ts) — the same
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
 * (`buildCemtexFile`, engine/src/payments/rail-cemtex.ts) — the same
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
