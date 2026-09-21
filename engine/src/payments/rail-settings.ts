import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealSecret, unsealJson, unsealSecret } from "../platform/secrets.ts";
import { PaymentError } from "./payment-errors.ts";

// ---------------------------------------------------------------------------
// Originator settings (tenant-owned payment bank profiles)
// ---------------------------------------------------------------------------

export interface EftSettings {
  /** 10-character originator ID assigned by the financial institution. */
  originatorId: string;
  /** Up to 15 characters; appears on payee statements. */
  originatorShortName: string;
  /** Up to 30 characters; appears on payee statements. */
  originatorLongName: string;
  /** 5-digit destination data centre code of the processing institution. */
  dataCentre: string;
  /**
   * 5-digit data centre of the ORIGINATING direct clearer (the org's own
   * institution), assigned by that institution — not the same number as
   * `dataCentre`, which identifies the destination. Both are components of the
   * item trace number (DE 12) and neither may be zero-filled.
   */
  originatingDataCentre: string;
  /** Payer (settlement) bank: 3-digit institution, 5-digit transit, account. */
  institution: string;
  transit: string;
  account: string;
  /** Optional CPA transaction code override; default 460 (accounts payable). */
  transactionCode?: string;
}

const EFT_REQUIRED: (keyof EftSettings)[] = [
  "originatorId",
  "originatorShortName",
  "originatorLongName",
  "dataCentre",
  "originatingDataCentre",
  "institution",
  "transit",
  "account",
];

export type EftSettingsResult =
  | { ok: true; settings: EftSettings }
  | { ok: false; missing: string[] };

/** Read and validate the org's EFT origination settings. Never fakes success. */
export async function loadEftSettings(orgId: string, runId?: string): Promise<EftSettingsResult> {
  const r = (await db.execute<{ originator_secrets_encrypted: string | null }>(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
      left join payment_runs r on r.payment_bank_profile_id = p.id and r.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.rail = 'cpa005_credit'
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `));
  const eft = unsealJson<Partial<EftSettings>>(r.rows[0]?.originator_secrets_encrypted) ?? {};
  const missing = EFT_REQUIRED.filter((k) => {
    const v = eft[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (missing.length > 0) return { ok: false, missing };
  const s = eft as EftSettings;
  if (!/^\d{5}$/.test(s.dataCentre)) return { ok: false, missing: ["dataCentre (must be 5 digits)"] };
  if (!/^\d{5}$/.test(s.originatingDataCentre) || Number(s.originatingDataCentre) === 0) {
    return { ok: false, missing: ["originatingDataCentre (must be 5 digits and greater than zero)"] };
  }
  if (!/^\d{3}$/.test(s.institution)) return { ok: false, missing: ["institution (must be 3 digits)"] };
  if (!/^\d{5}$/.test(s.transit)) return { ok: false, missing: ["transit (must be 5 digits)"] };
  if (!/^\d{1,12}$/.test(s.account)) return { ok: false, missing: ["account (1–12 digits)"] };
  if (s.originatorId.length > 10) return { ok: false, missing: ["originatorId (max 10 characters)"] };
  return { ok: true, settings: s };
}

// ---------------------------------------------------------------------------
// Counterparty bank account number encryption
// ---------------------------------------------------------------------------

/** Encrypt a payee bank account number for party_bank_accounts.account_number_encrypted. */
export function encryptAccountNumber(plain: string): string {
  return sealSecret(plain);
}

export function decryptAccountNumber(stored: string): string {
  const plain = unsealSecret(stored);
  if (plain === null) throw new PaymentError("stored bank account number is malformed or could not be decrypted");
  return plain;
}

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

export interface SepaSettings {
  originatorName: string;
  originatorIban: string;
  originatorBic: string;
}

/** ISO 13616 IBAN validation, including the mandatory mod-97 check. */
export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** ISO 9362 BIC: 8 characters, optionally followed by a 3-character branch. */
export function isValidBic(value: string): boolean {
  return /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(value.trim().toUpperCase());
}

export function validateSepaSettings(raw: Partial<SepaSettings> | null): { ok: true; settings: SepaSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing = (["originatorName", "originatorIban", "originatorBic"] as (keyof SepaSettings)[]).filter(
    (k) => typeof s[k] !== "string" || (s[k] as string).trim() === "" || (s[k] as string).includes("FILL-ME"),
  );
  if (typeof s.originatorIban === "string" && !isValidIban(s.originatorIban)) {
    missing.push("originatorIban");
  }
  if (typeof s.originatorBic === "string" && !isValidBic(s.originatorBic)) {
    missing.push("originatorBic");
  }
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    settings: {
      originatorName: s.originatorName!.trim(),
      originatorIban: s.originatorIban!.replace(/\s/g, "").toUpperCase(),
      originatorBic: s.originatorBic!.trim().toUpperCase(),
    },
  };
}

export async function loadSepaSettings(orgId: string, runId?: string) {
  const r = (await db.execute<{ originator_secrets_encrypted: string | null }>(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
      left join payment_runs r on r.payment_bank_profile_id = p.id and r.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.rail in ('sepa_credit', 'sepa_debit')
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `));
  return validateSepaSettings(unsealJson<Partial<SepaSettings>>(r.rows[0]?.originator_secrets_encrypted));
}

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

