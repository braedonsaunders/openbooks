import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp, formatMoney, fromUnits, sum, toUnits } from "./money.ts";
import {
  buildCpa005File,
  buildNachaFile,
  decryptAccountNumber,
  type Cpa005Payment,
  type EftSettings,
  type NachaEntry,
  type NachaSettings,
} from "./payments.ts";
import { stubPaymentMethods } from "./payroll-payment-method.ts";
import { PayrollError } from "./payroll-error.ts";
import { unsealJson } from "./secrets.ts";

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
export const PAYROLL_BANK_FILE_EXPORT_DISABLED_MESSAGE =
  "payroll bank-file export is unavailable until immutable artifact, approval, and download-audit controls are enabled";

export type PayRunBankFileFormat = "cpa005" | "nacha";

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
 * The two rails this product can originate payroll on, and the published
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
 *   COUNT — see below and `itemTraceNumber` in engine/src/payments.ts.
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
 * the transaction is REJECTED. `buildCpa005File` (engine/src/payments.ts)
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
 * Both writers are the audited AP ones in engine/src/payments.ts
 * (`buildCpa005File`, `buildNachaFile`) — payroll deliberately does not fork a
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
 * the one resolver (engine/src/payroll-payment-method.ts) so the file, the
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

/** CPA-005 is CRLF-terminated per the bank implementation guides; NACHA is per-ODFI. */
function lineEndingFor(row: ProfileRow, format: PayRunBankFileFormat): "lf" | "crlf" {
  if (format === "cpa005") return "crlf";
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

function resolveOriginator(row: ProfileRow, format: PayRunBankFileFormat): PayrollOriginatorResult {
  const resolved = format === "cpa005" ? resolveCpa005(row) : resolveNacha(row);
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
  /** CA: { institution, transit }. US: 9-digit ABA. */
  routing: Record<string, string>;
  accountNumber: string;
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
  documentId: string,
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
    if (format === "cpa005") {
      if (!/^\d{3}$/.test(routing.institution ?? "") || !/^\d{5}$/.test(routing.transit ?? "")) {
        problems.push(
          `${entry.employeeName}: CPA-005 needs a 3-digit institution and 5-digit transit number`,
        );
        continue;
      }
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
      accountNumber: decryptAccountNumber(row.account_number_encrypted),
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
 * Apply the tenant's record terminator and assert every record is still its
 * exact fixed width. A terminator that leaked into a record, or a record that
 * came out the wrong length, means every field after it has shifted.
 */
function applyLineEnding(
  content: string,
  lineEnding: "lf" | "crlf",
  recordLength: number,
): string {
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
  const credits = await loadCredits(orgId, documentId, population, format);
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
 * Build the run's direct-deposit file.
 *
 * Callers must come through ./payroll-bank-file-artifact.ts, which holds the
 * entitlement checks (committed, approval released, not already paid, not a
 * sandbox), allocates the bank-facing file number, and freezes the result.
 * This function assumes none of that and asserts everything it can prove from
 * the bytes it just produced.
 */
export async function buildPayRunBankFile(
  input: PayRunBankFileBuildInput,
): Promise<PayRunBankFileResult> {
  const format = input.format ?? input.originator.format;
  const spec = PAYROLL_BANK_FILE_FORMATS[format];
  if (!spec) throw new PayrollError(`unknown payroll bank-file format "${format}"`);
  return renderPayRunBankFile(
    await preparePayRunBankFile(input.orgId, input.documentId, format),
    input,
  );
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
    format === "cpa005" ? buildCpa005Payroll(input, credits) : buildNachaPayroll(input, credits),
    input.originator.lineEnding,
    format === "cpa005" ? 1464 : 94,
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

/** Money-safe cents → numeric(19,4) string, for reporting a parsed trailer. */
export function centsToMoney(cents: bigint): string {
  return fromUnits(cents * 100n);
}
