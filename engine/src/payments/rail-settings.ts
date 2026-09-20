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
// (engine/src/payments/rail-formatters.ts) with per-field source notes.
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

// ---------------------------------------------------------------------------
// Zengin (Japan) counterparty coordinates — SHAPE ONLY
// ---------------------------------------------------------------------------

/**
 * A Japanese bank code (金融機関コード / 統一金融機関番号): exactly 4 digits.
 *
 * Shape only: whether the code is allocated lives in the JBA-published
 * code tables, which are not transcribed here — a shaped-but-unallocated
 * code passes and the bank refuses it loudly. Never the IBAN validator:
 * a Japanese bank code plus branch code plus account number is not an IBAN.
 */
export function normalizeBankCode(value: string): string | null {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{4}$/.test(digits)) return null;
  return digits;
}

export function isValidBankCode(value: string): boolean {
  return normalizeBankCode(value) !== null;
}

/**
 * A Japanese branch code (支店コード / 統一店番号): exactly 3 digits.
 *
 * Same shape-only rule as the bank code: the allocation directory is the
 * bank's, not a transcription here.
 */
export function normalizeBranchCode(value: string): string | null {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{3}$/.test(digits)) return null;
  return digits;
}

export function isValidBranchCode(value: string): boolean {
  return normalizeBranchCode(value) !== null;
}

/**
 * A Japanese account number as the Zengin data record carries it: 1–7
 * digits, right-justified zero-filled to 7 (N(7)). Spaces and hyphens are
 * formatting and edit out; shorter numbers pad ("123456" → "0123456");
 * longer than seven digits even with hyphens edited out cannot be expressed
 * in the 7-character field and are refused, never truncated (truncation
 * pays a stranger). All zeros is not an account.
 */
export function normalizeZenginAccount(value: string): string | null {
  const stripped = value.replace(/[-\s]/g, "");
  if (stripped === "" || stripped.length > 7 || !/^\d+$/.test(stripped)) return null;
  if (/^0+$/.test(stripped)) return null;
  return stripped.padStart(7, "0");
}

/**
 * The Zengin kana channel: half-width katakana, ASCII capitals, digits and
 * a small symbol set — the only characters encodable in one Shift_JIS byte
 * each, which is what keeps every fixed-width field exactly its published
 * width on the wire.
 *
 * Mechanical, lossless mappings only: full-width alphanumerics fold to
 * half-width capitals, hiragana folds through full katakana to half-width
 * (が → ｶﾞ, two half-width characters, the JIS X 0201 form), full-width
 * katakana folds to half-width (ー → ｰ), and bank-documented symbols fold
 * to their half-width forms. Anything without a mechanical reading — kanji
 * above all — has NO mapping and returns null: a kanji name's reading is a
 * human-supplied フリガナ, not a derivable byte string, and guessing it
 * writes a stranger's name on the payee record. The caller refuses by name
 * with the remedy (register the payee's katakana name on the bank row).
 */
export function toZenginKana(value: string): string | null {
  const KATA_OFFSET = 0x30a1 - 0x3041; // ァ..ン minus ぁ..ん
  const halfKatakana: Record<string, string> = {
    "ァ": "ｧ", "ア": "ｱ", "ィ": "ｨ", "イ": "ｲ", "ゥ": "ｩ", "ウ": "ｳ",
    "ェ": "ｪ", "エ": "ｴ", "ォ": "ｫ", "オ": "ｵ", "カ": "ｶ", "ガ": "ｶﾞ",
    "キ": "ｷ", "ギ": "ｷﾞ", "ク": "ｸ", "グ": "ｸﾞ", "ケ": "ｹ", "ゲ": "ｹﾞ",
    "コ": "ｺ", "ゴ": "ｺﾞ", "サ": "ｻ", "ザ": "ｻﾞ", "シ": "ｼ", "ジ": "ｼﾞ",
    "ス": "ｽ", "ズ": "ｽﾞ", "セ": "ｾ", "ゼ": "ｾﾞ", "ソ": "ｿ", "ゾ": "ｿﾞ",
    "タ": "ﾀ", "ダ": "ﾀﾞ", "チ": "ﾁ", "ヂ": "ﾁﾞ", "ッ": "ｯ", "ツ": "ﾂ",
    "ヅ": "ﾂﾞ", "テ": "ﾃ", "デ": "ﾃﾞ", "ト": "ﾄ", "ド": "ﾄﾞ", "ナ": "ﾅ",
    "ニ": "ﾆ", "ヌ": "ﾇ", "ネ": "ﾈ", "ノ": "ﾉ", "ハ": "ﾊ", "バ": "ﾊﾞ",
    "パ": "ﾊﾟ", "ヒ": "ﾋ", "ビ": "ﾋﾞ", "ピ": "ﾋﾟ", "フ": "ﾌ", "ブ": "ﾌﾞ",
    "プ": "ﾌﾟ", "ヘ": "ﾍ", "ベ": "ﾍﾞ", "ペ": "ﾍﾟ", "ホ": "ﾎ", "ボ": "ﾎﾞ",
    "ポ": "ﾎﾟ", "マ": "ﾏ", "ミ": "ﾐ", "ム": "ﾑ", "メ": "ﾒ", "モ": "ﾓ",
    "ャ": "ｬ", "ヤ": "ﾔ", "ュ": "ｭ", "ユ": "ﾕ", "ョ": "ｮ", "ヨ": "ﾖ",
    "ラ": "ﾗ", "リ": "ﾘ", "ル": "ﾙ", "レ": "ﾚ", "ロ": "ﾛ", "ヮ": "ﾜ",
    "ワ": "ﾜ", "ヰ": "ｲ", "ヱ": "ｴ", "ヲ": "ｦ", "ン": "ﾝ", "ヴ": "ｳﾞ",
    "ー": "ｰ", "。": "｡", "、": "､", "・": "･", "「": "｢", "」": "｣",
  };
  const symbols: Record<string, string> = {
    "－": "-", "／": "/", "．": ".", "，": ",", "（": "(", "）": ")",
    "＆": "&", "＄": "$", "％": "%", "＋": "+", "；": ";", "＝": "=",
    "＊": "*", "＠": "@", "　": " ",
    // JIS X 0201 0x5C renders as the yen mark on Japanese systems; the
    // full-width yen sign folds there, never to a two-byte Shift_JIS form
    // that would shift every field after it.
    "￥": "\\", "¥": "\\",
  };
  const asciiPunct = new Set([" ", "-", "/", ".", ",", "(", ")", "&", "$", "%", "+", ";", "=", "*", "@", "\\"]);
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch >= "a" && ch <= "z") { out += ch.toUpperCase(); continue; }
    if ((ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9")) { out += ch; continue; }
    if (asciiPunct.has(ch)) { out += ch; continue; }
    // Half-width katakana (U+FF61–FF9F) already on the channel.
    if (code >= 0xff61 && code <= 0xff9f) { out += ch; continue; }
    // Full-width alphanumerics fold to half-width capitals.
    if (code >= 0xff21 && code <= 0xff3a) { out += String.fromCodePoint(code - 0xff21 + 0x41); continue; }
    if (code >= 0xff41 && code <= 0xff5a) { out += String.fromCodePoint(code - 0xff41 + 0x41); continue; }
    if (code >= 0xff10 && code <= 0xff19) { out += String.fromCodePoint(code - 0xff10 + 0x30); continue; }
    // Hiragana folds through full katakana first (ぁ..ん → ァ..ン).
    const kata = code >= 0x3041 && code <= 0x3096
      ? String.fromCodePoint(code + KATA_OFFSET)
      : ch;
    const half = halfKatakana[kata] ?? symbols[kata];
    if (half !== undefined) { out += half; continue; }
    return null;
  }
  return out;
}

// NOTE: Zengin originator settings ARE shaped here (unlike counterparty-only
// rails) because the writer needs exactly the bank-assigned values — the
// 10-digit 委託者コード, the kana 委託者名, and the originating bank/branch/
// 種目/account — and each is validated to its channel shape below. The file
// LAYOUT they populate is transcribed in `buildZenginFile`
// (engine/src/payments/rail-formatters.ts) with per-field source notes.
export interface ZenginSettings {
  /** 10-digit client code (委託者コード) assigned by the bank. */
  clientCode: string;
  /** Originator kana name (委託者名, ≤40 half-width chars after mapping). */
  clientName: string;
  /** Originating bank code (仕向銀行番号), 4 digits. */
  bankCode: string;
  /** Originating branch code (仕向支店番号), 3 digits. */
  branchCode: string;
  /** Originator deposit type (預金種目): 1 = 普通, 2 = 当座. */
  depositType: string;
  /** Originator account number (口座番号), 7 digits zero-filled. */
  accountNumber: string;
  /** Originating bank kana name (仕向銀行名, ≤15), blank when omitted. */
  bankName: string;
  /** Originating branch kana name (仕向支店名, ≤15), blank when omitted. */
  branchName: string;
}

const ZENGIN_REQUIRED: (keyof ZenginSettings)[] = [
  "clientCode", "clientName", "bankCode", "branchCode", "depositType", "accountNumber",
];

const kanaField = (value: string, len: number): string | null => {
  const mapped = toZenginKana(value.trim());
  if (mapped === null || mapped === "") return null;
  if (mapped.length > len) return null;
  return mapped;
};

// Optional kana names: blank, missing, or the unconfigured sentinel all mean
// "omitted" (all spaces on the wire) — never emitted as a bank name.
const isBlankish = (value: unknown): boolean =>
  typeof value !== "string" || value.trim() === "" || value.includes("FILL-ME");

export function validateZenginSettings(raw: Partial<ZenginSettings> | null): { ok: true; settings: ZenginSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing: string[] = ZENGIN_REQUIRED.filter((k) => {
    const v = s[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (!missing.includes("clientCode") && !/^\d{10}$/.test(s.clientCode!.trim())) {
    missing.push("clientCode (10-digit client code assigned by your bank)");
  }
  if (!missing.includes("clientName") && kanaField(s.clientName!, 40) === null) {
    missing.push("clientName (katakana originator name, max 40 half-width characters; kanji has no mechanical reading — register the kana name)");
  }
  if (!missing.includes("bankCode") && !isValidBankCode(s.bankCode!)) {
    missing.push("bankCode (4-digit originating bank code)");
  }
  if (!missing.includes("branchCode") && !isValidBranchCode(s.branchCode!)) {
    missing.push("branchCode (3-digit originating branch code)");
  }
  // Every salary-transfer manual prices the originator 種目 as 1 (普通) or
  // 2 (当座) only; the 貯蓄/その他 values appear solely in 総合振込 tables.
  if (!missing.includes("depositType") && s.depositType!.trim() !== "1" && s.depositType!.trim() !== "2") {
    missing.push("depositType (1 = 普通, 2 = 当座)");
  }
  if (!missing.includes("accountNumber") && normalizeZenginAccount(s.accountNumber!) === null) {
    missing.push("accountNumber (1–7 digits, zero-filled to 7)");
  }
  for (const key of ["bankName", "branchName"] as const) {
    const v = s[key];
    // Optional on every manual (省略可): absent means all spaces. A supplied
    // name must still be kana-mappable and fit its 15-char field.
    if (typeof v === "string" && v.trim() !== "" && !v.includes("FILL-ME") && kanaField(v, 15) === null) {
      missing.push(`${key} (katakana, max 15 half-width characters, or blank)`);
    }
  }
  if (missing.length) return { ok: false, missing: [...new Set(missing)] };
  return {
    ok: true,
    settings: {
      clientCode: s.clientCode!.trim(),
      clientName: kanaField(s.clientName!, 40)!,
      bankCode: normalizeBankCode(s.bankCode!)!,
      branchCode: normalizeBranchCode(s.branchCode!)!,
      depositType: s.depositType!.trim(),
      accountNumber: normalizeZenginAccount(s.accountNumber!)!,
      bankName: isBlankish(s.bankName) ? "" : kanaField(s.bankName!, 15)!,
      branchName: isBlankish(s.branchName) ? "" : kanaField(s.branchName!, 15)!,
    },
  };
}

export async function loadZenginSettings(orgId: string, runId?: string) {
  const r = (await db.execute<{ originator_secrets_encrypted: string | null }>(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
      left join payment_runs r on r.payment_bank_profile_id = p.id and r.org_id = p.org_id
     where p.org_id = ${orgId} and p.is_active and f.rail = 'zengin_credit'
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `));
  return validateZenginSettings(unsealJson<Partial<ZenginSettings>>(r.rows[0]?.originator_secrets_encrypted));
}
