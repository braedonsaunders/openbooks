import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { parseIsoDate } from "../platform/business-date.ts";
import { unsealJson } from "../platform/secrets.ts";
import { PaymentError } from "./payment-errors.ts";

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
// (engine/src/payments/rail-zengin.ts) with per-field source notes.
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

export interface ZenginPayment {
  /** Amount in yen (positive integer, max 10 digits — JPY has no minor unit). */
  amountYen: bigint;
  /** Destination bank code (金融機関コード), 4 digits. */
  bankCode: string;
  /** Destination branch code (支店コード), 3 digits. */
  branchCode: string;
  /** Destination deposit type (預金種目): "1" = 普通, "2" = 当座. */
  depositType: string;
  /** Destination account number, 1–7 digits (zero-filled on the wire). */
  accountNumber: string;
  /**
   * Payee name; mapped to half-width katakana on the wire. Kanji has no
   * mechanical reading and is refused — register the フリガナ instead.
   */
  payeeName: string;
  /** Employer-side employee number for the 社員番号 field (≤10 chars). */
  employeeNumber: string;
}

export interface ZenginRun {
  settings: ZenginSettings;
  /**
   * The salary transfer date (振込指定日): emitted as MMDD, as an explicit
   * civil day (YYYY-MM-DD) in the org's business time zone — a string, never
   * an instant, so the 取組日 bytes cannot shift with the server's zone.
   */
  transferDate: string;
  /** Detail payments — all salary transfers (種別コード 11, 給与振込). */
  payments: ZenginPayment[];
}

/**
 * Build a Zengin (全銀協規定形式) salary-transfer file — 給与振込, 種別コード
 * 11: one 120-byte header (データ区分 1), one 120-byte data record
 * (データ区分 2) per payment, one 120-byte trailer (8) and one 120-byte end
 * record (9), joined with CRLF. The returned string is the logical text
 * (half-width katakana + ASCII); `encodeZenginFile` renders the Shift_JIS
 * bytes the bank reads.
 *
 * EVIDENCE. The unreachable primary is the JBA's own fixed-width 規定
 * (every bank manual below cites 「全銀協規定フォーマットに準拠」; the
 * JBA-published document retrieved, 全国銀行協会 平成29年8月, specifies the
 * XML family, not this layout). The layout below is transcribed from SEVEN
 * concordant bank-published sources plus one vendor guide, retrieved
 * 2026-09-20, which agree on every field boundary (each source's widths sum
 * to exactly 120 per record):
 *
 * 1. MUFG Bank BizStation, 「給与・賞与振込（全銀形式）レコードフォーマット」
 *    — header (種別 11/12, 委託者コード N10, 委託者名 C40, 取組日 MMDD,
 *    仕向銀行/支店/種目/口座, ダミー C17), data (被仕向銀行 N4 + 銀行名 C15
 *    + 支店 N3 + 支店名 C15 + 手形交換所 N4 + 種目 N1 + 口座 N7 + 受取人 C30
 *    + 金額 N10 + 新規 N1 + 社員番号 N10 + 所属コード N10 + ダミー C9),
 *    trailer (件数 N6 + 金額 N12), end; the Shift_JIS-or-EBCDIC charset
 *    clause with its kana/character conversion tables; the 200,000-record
 *    cap; 新規コード fixed "0".
 * 2. Chiba Bank, 「給与・賞与振込（全銀協規定形式）」 — the same four
 *    records with 社員番号/所属コード as C(10) and ダミー C(9); CRLF after
 *    each 120 bytes; JIS-or-EBCDIC; 手形交換所 all zeros; 新規 "0".
 * 3. Tajima Bank, 「給与振込（全銀協規定形式）」 — 種別 11/12, the same
 *    data shape with 社員番号/所属コード C(10), ダミー C(9).
 * 4. Kiraboshi Bank, 「給与・賞与振込 振込依頼ファイル・フォーマット
 *    （全銀協規定形式）」(20241202) — the same four records, 社員番号/
 *    所属コード C(10) marked optional, CR+LF/CR/LF accepted, コード区分
 *    0…JIS 1…EBCDIC.
 * 5. Tsuruga Shinkin, 「全銀ファイル フォーマット」 — 種別コード 総合:21、
 *    給与:11、賞与:12; the shared header/trailer/end; the note that
 *    識別表示 Y (EDI) is 無効 for 給与・賞与振込 — salary records carry no
 *    EDI block, hence the 9-char ダミー.
 * 6. MUFG Trust, 「総合振込（全銀協規定形式）」(manual05) — the shared
 *    header/trailer/end shapes and the N/C justification rules (N 右詰0埋め,
 *    C 左詰スペース埋め); its data record is the 総合振込 variant
 *    (顧客コード/振込区分/識別表示/EDI), which salary does NOT carry.
 * 7. Docomo SMTB Net Bank, 「全銀協規定形式（振込ファイル）」 — the shared
 *    shapes with the explicit tie コード区分「0」 = シフトJIS and
 *    CR+LF terminators on 120-byte records.
 * 8. Yamada-tools, 「全銀フォーマット完全ガイド【2026年版】」(vendor
 *    secondary, 2026-03-27) — 1-indexed byte positions for the shared
 *    header/data skeleton, the kana-only rule, Shift_JIS, and zero-padding
 *    short account numbers; asserts 種別 11/12 for salary/bonus.
 *
 * Corroboration gradient, stated plainly: every MONEY byte (data-record
 * positions 1–91 and the trailer counts/totals) is 7-bank-unanimous with
 * 1-indexed positions cross-checked; the salary tail (社員番号/所属コード/
 * ダミー at 92–120) is 4-bank-unanimous on offsets with ONE attribute
 * disagreement — MUFG prints N(10) zero-filled, Chiba/Tajima/Kiraboshi print
 * C(10) — resolved to C(10) left-justified space-filled by 3-to-1 majority,
 * safe because MUFG itself accepts space remainders there and the field is
 * reconciliation-only (it cannot address money). No published byte artifact
 * (an accepted file's bytes) was reachable; no bank publishes one.
 *
 * Rejected with reason: the vendor guide's aside that salary may also use
 * 種別 71 (and bonus 72) — no bank manual among (1)–(7) lists 71/72 for the
 * header 種別コード, so the file emits 11 (給与振込) and a bonus-only file is
 * a future variant, not a silent 12. The 賞与 code 12 differs from 11 in
 * exactly those two bytes (sources (1)–(4) share one layout table for both).
 *
 * Why the residual single-attribute point is shippable: the 社員番号 field
 * is informational — banks match and settle on bank/branch/種目/account plus
 * the trailer totals, all unanimous. A wrong 社員番号 justification cannot
 * redirect a credit; at worst an employer's reconciliation match needs the
 * documented form.
 *
 * ENCODING (part of the format, not an implementation detail): text fields
 * are half-width katakana in Shift_JIS (sources (1), (7), (8) state Shift_JIS
 * outright; (2)–(4) state JIS-or-EBCDIC with コード区分, and (7) ties
 * コード区分「0」 to シフトJIS — hence コード区分 "0", contentType
 * `text/plain; charset=Shift_JIS`, and bytes via `encodeZenginFile`). The
 * file is NEVER valid UTF-8: uploading the logical string as UTF-8 makes
 * every payee name unreadable and shifts every field after it.
 *
 * JPY has no minor unit: amounts are whole yen, N(10) per credit
 * (max 9,999,999,999) and N(12) in the trailer. Sub-yen values are refused,
 * never rounded — rounding a net pay changes what the employee is owed.
 *
 * The transfer date is MMDD only (the 規定 has no year field); the bank
 * interprets it inside its processing window, so a file generated far from
 * its transfer date is the bank's loud rejection, never a silent misdate.
 */
export function buildZenginFile(run: ZenginRun): string {
  const checked = validateZenginSettings(run.settings);
  if (!checked.ok) {
    throw new PaymentError(`Zengin originator settings are invalid: ${checked.missing.join(", ")}`);
  }
  const s = checked.settings;
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");
  // MUFG BizStation caps one transmission at 200,000 data records. Past the
  // cap is a named refusal, never a silently over-long file the bank rejects.
  if (run.payments.length > 200_000) {
    throw new PaymentError(
      `Zengin file holds at most 200,000 detail records but the run has ${run.payments.length} — split the pay run`,
    );
  }

  const num = (value: string, len: number, what: string): string => {
    if (value.length > len || !/^\d*$/.test(value)) {
      throw new PaymentError(`Zengin ${what} "${value}" does not fit in ${len} digits`);
    }
    return value.padStart(len, "0");
  };
  const text = (value: string, len: number, what: string): string => {
    if (value.length > len) {
      throw new PaymentError(`Zengin ${what} does not fit in ${len} characters`);
    }
    return value.padEnd(len, " ");
  };
  const yen = (value: bigint, len: number, what: string): string => {
    const digits = String(value);
    if (value <= 0n) throw new PaymentError("payment amounts must be positive");
    if (digits.length > len) {
      throw new PaymentError(`Zengin ${what} ${digits} yen does not fit in ${len} digits — split the pay run`);
    }
    return digits.padStart(len, "0");
  };
  const bank = (value: string, what: string): string => {
    const normal = normalizeBankCode(value);
    if (!normal) throw new PaymentError(`Zengin ${what} "${value}" is not a 4-digit bank code`);
    return normal;
  };
  const branch = (value: string, what: string): string => {
    const normal = normalizeBranchCode(value);
    if (!normal) throw new PaymentError(`Zengin ${what} "${value}" is not a 3-digit branch code`);
    return normal;
  };
  const account = (value: string, what: string): string => {
    const normal = normalizeZenginAccount(value);
    if (normal === null) {
      throw new PaymentError(`Zengin ${what} "${value}" is not a 1–7 digit account number`);
    }
    return normal;
  };
  const depositType = (value: string, what: string): string => {
    // Four salary-transfer manuals price the payee 種目 as 1 (普通) or 2
    // (当座) only; 4 (貯蓄) and 9 (その他) appear solely in 総合振込 tables,
    // so they are refused here rather than emitted into an account-address
    // byte the salary channel does not define.
    if (value !== "1" && value !== "2") {
      throw new PaymentError(`Zengin ${what} "${value}" must be 1 (普通) or 2 (当座)`);
    }
    return value;
  };
  // Transfer date MMDD from an already-zoned civil day (YYYY-MM-DD): UTC
  // accessors on the parsed date read the same parts on every host. Local
  // getMonth/getDate here would reintroduce server-zone bytes.
  const mmdd = (iso: string): string => {
    let month: string;
    let day: string;
    try {
      const parsed = parseIsoDate(iso);
      month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
      day = String(parsed.getUTCDate()).padStart(2, "0");
    } catch {
      throw new PaymentError(`Zengin transfer date "${iso}" is not a valid YYYY-MM-DD civil day`);
    }
    return `${month}${day}`;
  };

  const transferDay = mmdd(run.transferDate);

  // -- 1: header (120) ----------------------------------------------------
  // 1(1) + 種別 11(2–3) + コード区分 0(4) + 委託者コード(5–14) +
  // 委託者名(15–54) + 取組日 MMDD(55–58) + 仕向銀行番号(59–62) +
  // 仕向銀行名(63–77) + 仕向支店番号(78–80) + 仕向支店名(81–95) +
  // 預金種目(96) + 口座番号(97–103) + ダミー(104–120).
  const header =
    "1" +
    "11" + // 種別コード: 給与振込 (賞与 12 differs in these bytes only)
    "0" + // コード区分: JIS (Shift_JIS bytes via encodeZenginFile)
    num(s.clientCode, 10, "client code") +
    text(s.clientName, 40, "client name") +
    transferDay +
    bank(s.bankCode, "originating bank code") +
    text(s.bankName, 15, "originating bank name") +
    branch(s.branchCode, "originating branch code") +
    text(s.branchName, 15, "originating branch name") +
    depositType(s.depositType, "originating deposit type") +
    account(s.accountNumber, "originating account number") +
    " ".repeat(17);
  if (header.length !== 120) throw new PaymentError("internal error: Zengin header record is not 120 characters");

  // -- 2: details (120 each) ------------------------------------------------
  // 2(1) + 被仕向銀行番号(2–5) + 被仕向銀行名(6–20) + 被仕向支店番号(21–23) +
  // 被仕向支店名(24–38) + 手形交換所番号(39–42) + 預金種目(43) +
  // 口座番号(44–50) + 受取人名(51–80) + 振込金額(81–90) + 新規コード(91) +
  // 社員番号(92–101) + 所属コード(102–111) + ダミー(112–120).
  const details = run.payments.map((p) => {
    const payee = toZenginKana(p.payeeName);
    if (payee === null || payee.trim() === "") {
      throw new PaymentError(
        `Zengin payee name "${p.payeeName}" cannot be expressed in half-width katakana — register the payee's katakana name (フリガナ) on the employee's approved bank account`,
      );
    }
    // 社員番号 rides the channel too: an unmappable number refuses by
    // employee name here (not as an anonymous encoder error later), while
    // an empty one is legal — every manual marks the field optional.
    const empRaw = toZenginKana(p.employeeNumber);
    if (empRaw === null) {
      throw new PaymentError(
        `Zengin employee number "${p.employeeNumber}" for ${p.payeeName} cannot be expressed in half-width katakana`,
      );
    }
    const record =
      "2" +
      bank(p.bankCode, `destination bank code for ${p.payeeName}`) +
      " ".repeat(15) + // 被仕向銀行名: optional (省略可) on every manual
      branch(p.branchCode, `destination branch code for ${p.payeeName}`) +
      " ".repeat(15) + // 被仕向支店名: optional (省略可) on every manual
      "0000" + // 手形交換所番号: all zeros (unused)
      depositType(p.depositType, `deposit type for ${p.payeeName}`) +
      account(p.accountNumber, `destination account for ${p.payeeName}`) +
      // 受取人名: the bank matches on account coordinates, not the name —
      // over-length display names truncate (cf. CPA-005 30, Bacs 18),
      // unmappable ones (kanji) refuse above, never guess a reading.
      payee.slice(0, 30).padEnd(30, " ") +
      yen(p.amountYen, 10, `transfer to ${p.payeeName}`) +
      "0" + // 新規コード: "0" fixed for salary on every manual
      // 社員番号 C(10): reconciliation-only; the employer's number as-is,
      // truncated to the field (never re-justified into a new identifier).
      empRaw.slice(0, 10).padEnd(10, " ") +
      " ".repeat(10) + // 所属コード: no department code is carried
      " ".repeat(9); // ダミー: salary carries no EDI block
    if (record.length !== 120) throw new PaymentError("internal error: Zengin data record is not 120 characters");
    return record;
  });

  // -- 8: trailer (120) -----------------------------------------------------
  // 8(1) + 合計件数 N6(2–7) + 合計金額 N12 yen(8–19) + ダミー(20–120).
  const total = run.payments.reduce((acc, p) => acc + p.amountYen, 0n);
  const trailer =
    "8" +
    num(String(run.payments.length), 6, "detail count") +
    yen(total, 12, "trailer total") +
    " ".repeat(101);
  if (trailer.length !== 120) throw new PaymentError("internal error: Zengin trailer record is not 120 characters");

  // -- 9: end (120) ---------------------------------------------------------
  const end = "9" + " ".repeat(119);
  if (end.length !== 120) throw new PaymentError("internal error: Zengin end record is not 120 characters");

  return [header, ...details, trailer, end].join("\r\n") + "\r\n";
}

/**
 * Render the logical Zengin text as the Shift_JIS bytes the bank reads.
 *
 * Hand-rolled JIS X 0201 (not iconv): the channel alphabet is exactly ASCII
 * printable + half-width katakana, each one Shift_JIS byte, so the encoder
 * is a small total table — and anything outside it (a kanji that slipped
 * past validation, a full-width character, an emoji) is a thrown refusal,
 * never a `?` replacement byte that would silently shift every field after
 * it. CRLF passes through as 0x0D 0x0A.
 */
export function encodeZenginFile(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\r") { bytes.push(0x0d); continue; }
    if (ch === "\n") { bytes.push(0x0a); continue; }
    // JIS X 0201 Roman: ASCII printable; 0x5C is the yen mark (¥) on
    // Japanese systems and the kana-channel backslash folds there.
    if (code >= 0x20 && code <= 0x7e) { bytes.push(code); continue; }
    // JIS X 0201 katakana: U+FF61–FF9F → 0xA1–0xDF.
    if (code >= 0xff61 && code <= 0xff9f) { bytes.push(code - 0xff61 + 0xa1); continue; }
    throw new PaymentError(
      `Zengin file contains U+${code.toString(16).toUpperCase().padStart(4, "0")} "${ch}", which has no Shift_JIS single-byte form — names must be half-width katakana before encoding`,
    );
  }
  return Buffer.from(bytes);
}
