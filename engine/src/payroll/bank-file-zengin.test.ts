import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { ensureBuiltInPaymentFormats } from "../payments/operations.ts";
import { createScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { buildZenginFile, encodeZenginFile } from "../payments/rail-formatters.ts";
import { PaymentError } from "../payments/payment-errors.ts";
import {
  isValidBankCode,
  isValidBranchCode,
  normalizeBankCode,
  normalizeBranchCode,
  normalizeZenginAccount,
  toZenginKana,
  validateZenginSettings,
} from "../payments/rail-settings.ts";
import {
  PAYROLL_BANK_FILE_FORMATS,
  payrollBankProfiles,
  payrollOriginatorConfig,
  readTrailerTotals,
  renderPayRunBankFile,
  resolveZenginCreditor,
  type PayRunBankFileInputs,
  type PayrollOriginatorConfig,
} from "./bank-file.ts";
import { PayrollError } from "./error.ts";

/**
 * Payroll Zengin disbursement — 給与振込 (salary transfer, 種別コード 11)
 * in 全銀協規定形式.
 *
 * The name is `zengin`, the rail `zengin_credit`, the currency JPY; Japanese
 * bank details are a 4-digit bank code plus a 3-digit branch code plus a
 * 7-digit account number, never an IBAN. The writer is the shared AP builder
 * (`buildZenginFile` + `encodeZenginFile`,
 * engine/src/payments/rail-formatters.ts), whose evidence log names every
 * source with publisher and date: MUFG Bank BizStation, Chiba Bank, Tajima
 * Bank and Kiraboshi Bank salary-transfer manuals (all 種別 11/12 with full
 * 120-byte tables), the Tsuruga Shinkin / MUFG Trust / Docomo SMTB Net Bank
 * shared-shape manuals, and the Yamada-tools 2026 guide's 1-indexed byte
 * positions. The money bytes are seven-bank-unanimous; the salary tail
 * (社員番号/所属コード/ダミー at 92–120) is four-bank-unanimous on offsets
 * with one attribute disagreement resolved 3-to-1 — see the builder.
 *
 * Three things are under test and they differ in kind:
 *
 * 1. REUSE. Payroll must call the shared AP builder (`buildZenginFile`), not
 *    carry a second Zengin implementation. The parity test asserts payroll's
 *    emitted characters EQUAL the shared builder's output for the same
 *    inputs, and the byte-position test asserts the builder's characters
 *    against the banks' published 1-indexed offsets — agreement between
 *    independent transcriptions, not with ourselves.
 * 2. THE GOLDEN. The emitted characters asserted character for character:
 *    the 120-byte header, two 120-byte data records, the trailer and the end
 *    record — CRLF-terminated — plus the Shift_JIS bytes asserted byte for
 *    byte at the channel boundary. The two-credit EFT population totals
 *    ¥380,233 with a ¥69,767 paper exclusion: gross ¥450,000, the JP
 *    persona's proven figures, so the golden ties to the run it pays.
 * 3. REFUSAL. An employee row without a shaped bank/branch/account triple —
 *    or a payee name with no kana reading — is a named refusal with the
 *    cheque remedy: never silently dropped, never coerced (a coerced bank
 *    code pays a stranger), never a guessed reading. The whole file refuses
 *    rather than paying some and dropping another.
 *
 * All tests here are pure (no database) except the rail-reachability test at
 * the end: the render path takes every input explicitly, which is what makes
 * the stored artifact reproducible evidence.
 */

const ZENGIN_ORIGINATOR: PayrollOriginatorConfig = {
  paymentBankProfileId: "55555555-5555-4555-8555-555555555555",
  profileName: "Payroll direct deposit (Zengin)",
  format: "zengin",
  currency: "JPY",
  lineEnding: "crlf",
  zengin: {
    clientCode: "2012345678",
    clientName: "ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ",
    bankCode: "0005",
    branchCode: "110",
    depositType: "1",
    accountNumber: "1234567",
    bankName: "",
    branchName: "",
  },
};

const zenginInputs = (): PayRunBankFileInputs => ({
  format: "zengin",
  population: {
    entries: [],
    total: "380233.0000",
    excludedCheque: [
      { employeePartyId: "p3", employeeName: "CY OVERRIDE", amount: "69767.0000", reason: "profile" },
    ],
    excludedTotal: "69767.0000",
  },
  credits: [
    {
      stubId: "s1", employeePartyId: "p1", employeeName: "ADA WIDGET", amount: "250000.0000",
      employeeNumber: "EMP-0001", routing: { bankCode: "0005", branchCode: "110", depositType: "1" },
      accountNumber: "8000001",
      bankCode: "0005", branchCode: "110", depositType: "1", payeeKana: "ｴｲﾃﾞｨｰ",
    },
    {
      stubId: "s2", employeePartyId: "p2", employeeName: "BO SAVER", amount: "130233.0000",
      employeeNumber: "EMP-0002", routing: { bankCode: "9900", branchCode: "018", depositType: "1" },
      accountNumber: "0123456",
      bankCode: "9900", branchCode: "018", depositType: "1", payeeKana: "BO SAVER",
    },
  ],
});

const renderZengin = (inputs = zenginInputs(), originator = ZENGIN_ORIGINATOR) =>
  renderPayRunBankFile(inputs, {
    orgId: "org",
    documentId: "doc",
    format: "zengin",
    originator,
    // The transfer date: the run's pay date backs the header 取組日 MMDD.
    fundsDate: "2026-08-21",
    createdAt: new Date(2026, 7, 14, 9, 30, 0),
  });

/* ------------------------------------------------------------------ */
/* Format registration                                                 */
/* ------------------------------------------------------------------ */

test("the Zengin format is registered, enabled, and settled in JPY on the zengin_credit rail", () => {
  const spec = PAYROLL_BANK_FILE_FORMATS.zengin;
  assert.equal(spec.enabled, true);
  assert.equal(spec.currency, "JPY");
  assert.deepEqual(spec.rails, ["zengin_credit"]);
  assert.equal(spec.extension, "txt");
  assert.equal(spec.contentType, "text/plain; charset=Shift_JIS");
  assert.equal(spec.disabledReason, undefined);
});

/* ------------------------------------------------------------------ */
/* Golden file — the emitted characters, character for character        */
/* ------------------------------------------------------------------ */

/**
 * The golden document, written literally field by field against the bank
 * tables (every record 120 chars, CRLF-terminated):
 *
 * Header: "1" (1) | "11" 給与振込 (2–3) | "0" JIS (4) | client code
 * "2012345678" (5–14) | client kana "ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ" + 29 spaces (15–54) |
 * 取組日 "0821" (55–58, the pay date) | bank "0005" (59–62) | 15 spaces
 * bank name (63–77) | branch "110" (78–80) | 15 spaces branch name (81–95) |
 * 種目 "1" (96) | account "1234567" (97–103) | 17 spaces (104–120).
 *
 * Detail: "2" (1) | bank (2–5) | 15 spaces bank name (6–20) | branch
 * (21–23) | 15 spaces branch name (24–38) | "0000" (39–42) | 種目 (43) |
 * account (44–50) | payee kana (51–80) | yen ZF (81–90) | "0" (91) |
 * 社員番号 (92–101) | 10 spaces 所属 (102–111) | 9 spaces ダミー (112–120).
 *
 * Trailer: "8" (1) | count "000002" (2–7) | total "000000380233" (8–19,
 * ¥380,233) | 101 spaces (20–120). End: "9" + 119 spaces.
 */
const ZENGIN_GOLDEN =
  "11102012345678ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ                             08210005               110               11234567                 \r\n" +
  "20005               110               000018000001ｴｲﾃﾞｨｰ                        00002500000EMP-0001                     \r\n" +
  "29900               018               000010123456BO SAVER                      00001302330EMP-0002                     \r\n" +
  "8000002000000380233                                                                                                     \r\n" +
  "9                                                                                                                       \r\n";

test("Zengin golden file — character for character against the bank tables", () => {
  const result = renderZengin();
  assert.equal(result.content, ZENGIN_GOLDEN);
  assert.equal(result.contentType, "text/plain; charset=Shift_JIS");
  assert.equal(result.extension, "txt");
  assert.equal(result.currency, "JPY");
});

test("every golden record carries its label and exact width, terminators outside", () => {
  const result = renderZengin();
  assert.ok(result.content.endsWith("\r\n"));
  const records = result.content.split("\r\n").filter((line) => line.length > 0);
  assert.equal(records.length, 5);
  for (const record of records) assert.equal(record.length, 120);
  assert.equal(records[0]![0], "1");
  assert.equal(records[1]![0], "2");
  assert.equal(records[2]![0], "2");
  assert.equal(records[3]![0], "8");
  assert.equal(records[4]![0], "9");
});

test("the golden trailer ties to the run at its published offsets", () => {
  const result = renderZengin();
  const trailer = result.content.split("\r\n").find((line) => line[0] === "8")!;
  assert.equal(trailer.slice(1, 7), "000002");
  assert.equal(trailer.slice(7, 19), "000000380233");
  assert.deepEqual(readTrailerTotals("zengin", result.content), { totalCents: 380233n, count: 2 });
});

test("the golden header transfer date is the run's pay date as MMDD", () => {
  const result = renderZengin();
  const header = result.content.split("\r\n")[0]!;
  // 取組日 at 1-indexed positions 55–58: August 21 → "0821".
  assert.equal(header.slice(54, 58), "0821");
  assert.equal(header.slice(1, 3), "11");
  assert.equal(header.slice(3, 4), "0");
});

/* ------------------------------------------------------------------ */
/* The independent byte positions — every data offset, field by field   */
/* ------------------------------------------------------------------ */

/**
 * The Yamada-tools 2026 guide prints 1-indexed byte positions for the shared
 * header/data skeleton (2–5 bank, 6–20 bank name, 21–23 branch, 24–38 branch
 * name, 39–42 交換所, 43 種目, 44–50 account, 51–80 payee, 81–90 amount, 91
 * 新規), and the four salary manuals print the salary tail (92–101 社員番号,
 * 102–111 所属コード, 112–120 ダミー). This test feeds shaped inputs through
 * the shared builder and asserts the same slices (0-indexed here) — a
 * lookalike with a shifted layout cannot pass it, and agreement here is
 * agreement between independent transcriptions, not with ourselves.
 */
test("the published byte positions match at every data offset", () => {
  const file = buildZenginFile({
    settings: ZENGIN_ORIGINATOR.zengin!,
    transferDate: new Date("2026-12-10T00:00:00"),
    payments: [{
      amountYen: 380233n,
      bankCode: "0005",
      branchCode: "110",
      depositType: "2",
      accountNumber: "123",
      payeeName: "ﾔﾏﾀﾞﾀﾛｳ",
      employeeNumber: "12345",
    }],
  });
  const records = file.split("\r\n").filter((line) => line.length > 0);
  assert.equal(records.length, 4);

  const header = records[0]!;
  assert.equal(header.slice(0, 1), "1");
  assert.equal(header.slice(1, 3), "11");
  assert.equal(header.slice(3, 4), "0");
  assert.equal(header.slice(4, 14), "2012345678");
  assert.equal(header.slice(14, 54), "ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ".padEnd(40, " "));
  assert.equal(header.slice(54, 58), "1210");
  assert.equal(header.slice(58, 62), "0005");
  assert.equal(header.slice(62, 77), " ".repeat(15));
  assert.equal(header.slice(77, 80), "110");
  assert.equal(header.slice(80, 95), " ".repeat(15));
  assert.equal(header.slice(95, 96), "1");
  assert.equal(header.slice(96, 103), "1234567");
  assert.equal(header.slice(103, 120), " ".repeat(17));

  const detail = records[1]!;
  assert.equal(detail.slice(0, 1), "2");
  assert.equal(detail.slice(1, 5), "0005");
  assert.equal(detail.slice(5, 20), " ".repeat(15));
  assert.equal(detail.slice(20, 23), "110");
  assert.equal(detail.slice(23, 38), " ".repeat(15));
  assert.equal(detail.slice(38, 42), "0000");
  assert.equal(detail.slice(42, 43), "2");
  assert.equal(detail.slice(43, 50), "0000123");
  assert.equal(detail.slice(50, 80), "ﾔﾏﾀﾞﾀﾛｳ".padEnd(30, " "));
  assert.equal(detail.slice(80, 90), "0000380233");
  assert.equal(detail.slice(90, 91), "0");
  assert.equal(detail.slice(91, 101), "12345".padEnd(10, " "));
  assert.equal(detail.slice(101, 111), " ".repeat(10));
  assert.equal(detail.slice(111, 120), " ".repeat(9));

  const trailer = records[2]!;
  assert.equal(trailer.slice(0, 1), "8");
  assert.equal(trailer.slice(1, 7), "000001");
  assert.equal(trailer.slice(7, 19), "000000380233");
  assert.equal(trailer.slice(19, 120), " ".repeat(101));

  const end = records[3]!;
  assert.equal(end, "9" + " ".repeat(119));
});

/* ------------------------------------------------------------------ */
/* Shift_JIS bytes — the bank's bytes, not UTF-8 of the logical text    */
/* ------------------------------------------------------------------ */

test("the renderer carries the Shift_JIS bytes the bank reads", () => {
  const result = renderZengin();
  assert.ok(result.contentBytes instanceof Buffer);
  assert.deepEqual(result.contentBytes, encodeZenginFile(result.content));
  // Single-byte channel: one byte per character, so no field ever shifts.
  assert.equal(result.contentBytes.length, result.content.length);
});

test("the kana channel encodes to its JIS X 0201 bytes", () => {
  // ASCII printable passes through; half-width katakana maps U+FF61–FF9F →
  // 0xA1–0xDF (ｱ U+FF71 → 0xB1); CRLF passes through as 0x0D 0x0A.
  assert.deepEqual([...encodeZenginFile("A1 ｱ\r\n").values()], [0x41, 0x31, 0x20, 0xb1, 0x0d, 0x0a]);
  // ｶ U+FF76 → 0xB6; ｰ U+FF70 → 0xB0 (the U+FF61–FF9F → 0xA1–0xDF
  // range is linear, including ﾞ/ﾟ at 0xDE/0xDF).
  assert.deepEqual([...encodeZenginFile("ｶｰ").values()], [0xb6, 0xb0]);
});

test("the encoder refuses anything without a single-byte form — never a replacement byte", () => {
  // Full-width katakana must be channel-mapped first: raw ア (U+30A2) has no
  // single-byte Shift_JIS form and refuses rather than emitting 0x83 0x41
  // (two bytes that would shift every field after it).
  assert.throws(
    () => encodeZenginFile("ア"),
    (error: Error) => error instanceof PaymentError && /no Shift_JIS single-byte form/.test(error.message),
  );
  assert.throws(
    () => encodeZenginFile("山"),
    (error: Error) => error instanceof PaymentError && /no Shift_JIS single-byte form/.test(error.message),
  );
});

test("the golden bytes decode back to the golden characters under Shift_JIS", () => {
  const result = renderZengin();
  // Node's ICU-backed decoder is the independent check: our hand-rolled
  // encoder agrees with the platform Shift_JIS table on every byte.
  assert.equal(new TextDecoder("shift_jis").decode(result.contentBytes!), result.content);
});

/* ------------------------------------------------------------------ */
/* Parity — payroll's characters ARE the shared builder's characters    */
/* ------------------------------------------------------------------ */

test("payroll's Zengin output equals the shared AP builder's output for the same inputs", () => {
  const viaPayroll = renderZengin().content;
  // The same mapping payroll applies, written out longhand. If payroll ever
  // forks its own Zengin writer, this diverges.
  const viaSharedBuilder = buildZenginFile({
    settings: ZENGIN_ORIGINATOR.zengin!,
    transferDate: new Date("2026-08-21T00:00:00"),
    payments: [
      {
        amountYen: 250000n,
        bankCode: "0005",
        branchCode: "110",
        depositType: "1",
        accountNumber: "8000001",
        payeeName: "ｴｲﾃﾞｨｰ",
        employeeNumber: "EMP-0001",
      },
      {
        amountYen: 130233n,
        bankCode: "9900",
        branchCode: "018",
        depositType: "1",
        accountNumber: "0123456",
        payeeName: "BO SAVER",
        employeeNumber: "EMP-0002",
      },
    ],
  });
  assert.equal(viaPayroll, viaSharedBuilder);
});

/* ------------------------------------------------------------------ */
/* Refusal — unusable bank details refuse the whole file                */
/* ------------------------------------------------------------------ */

test("a missing bank code names the employee and the cheque fallback", () => {
  const resolved = resolveZenginCreditor("ADA WIDGET", { branchCode: "110", depositType: "1" }, "8000001");
  if (resolved.ok) assert.fail("a missing bank code must not resolve");
  assert.match(resolved.reason, /ADA WIDGET/);
  assert.match(resolved.reason, /bank code/);
  assert.match(resolved.reason, /cheque/);
});

test("a malformed bank or branch code is refused rather than written into the address field", () => {
  for (const bad of ["123", "12345", "ABCD", ""]) {
    const resolved = resolveZenginCreditor("ADA WIDGET", { bankCode: bad, branchCode: "110", depositType: "1" }, "8000001");
    if (resolved.ok) assert.fail(`bank code "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA WIDGET/);
  }
  for (const bad of ["12", "1234", "ABC", ""]) {
    const resolved = resolveZenginCreditor("ADA WIDGET", { bankCode: "0005", branchCode: bad, depositType: "1" }, "8000001");
    if (resolved.ok) assert.fail(`branch code "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA WIDGET/);
  }
});

test("a deposit type outside {1, 2} is refused — the salary channel defines no other address byte", () => {
  for (const bad of ["4", "9", "0", ""]) {
    const resolved = resolveZenginCreditor("ADA WIDGET", { bankCode: "0005", branchCode: "110", depositType: bad }, "8000001");
    if (resolved.ok) assert.fail(`deposit type "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA WIDGET/);
  }
});

test("an account number that is not 1–7 digits is refused, never truncated", () => {
  for (const bad of ["12345678", "ABCDEFG", "", "0000000"]) {
    const resolved = resolveZenginCreditor("ADA WIDGET", { bankCode: "0005", branchCode: "110", depositType: "1" }, bad);
    if (resolved.ok) assert.fail(`account "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA WIDGET/);
  }
});

test("a short account number zero-pads — the padding is formatting, not identity", () => {
  assert.deepEqual(
    resolveZenginCreditor("BO SAVER", { bankCode: "9900", branchCode: "018", depositType: "1" }, "123456"),
    { ok: true, bankCode: "9900", branchCode: "018", depositType: "1", accountNumber: "0123456", payeeKana: "BO SAVER" },
  );
});

test("a kanji payee name refuses with the furigana remedy — readings are never guessed", () => {
  const resolved = resolveZenginCreditor("山田太郎", { bankCode: "0005", branchCode: "110", depositType: "1" }, "8000001");
  if (resolved.ok) assert.fail("a kanji name must not resolve");
  assert.match(resolved.reason, /山田太郎/);
  assert.match(resolved.reason, /payeeKana/);
  assert.match(resolved.reason, /cheque/);
});

test("an explicit kana name on the bank row wins over an unmappable employee name", () => {
  assert.deepEqual(
    resolveZenginCreditor(
      "山田太郎",
      { bankCode: "0005", branchCode: "110", depositType: "1", payeeKana: "ヤマダタロウ" },
      "8000001",
    ),
    {
      ok: true, bankCode: "0005", branchCode: "110", depositType: "1",
      accountNumber: "8000001", payeeKana: "ﾔﾏﾀﾞﾀﾛｳ",
    },
  );
});

test("hiragana and full-width names map mechanically — only kanji refuses", () => {
  const base = { bankCode: "0005", branchCode: "110", depositType: "1" };
  const hiragana = resolveZenginCreditor("やまだたろう", base, "8000001");
  if (!hiragana.ok) assert.fail("hiragana must map mechanically");
  assert.equal(hiragana.payeeKana, "ﾔﾏﾀﾞﾀﾛｳ");
  const fullWidth = resolveZenginCreditor("ＹＡＭＡＤＡ", base, "8000001");
  if (!fullWidth.ok) assert.fail("full-width ASCII must fold");
  assert.equal(fullWidth.payeeKana, "YAMADA");
});

test("a credit that reaches the renderer without resolved coordinates is refused, not emitted", () => {
  const inputs = zenginInputs();
  delete (inputs.credits[0] as { bankCode?: string }).bankCode;
  assert.throws(
    () => renderZengin(inputs),
    (error: Error) =>
      error instanceof PayrollError && /ADA WIDGET.*no validated Zengin coordinates/.test(error.message),
  );
});

test("an unconfigured Zengin originator is refused by name rather than emitting bytes the bank misreads", () => {
  assert.throws(
    () =>
      renderZengin(zenginInputs(), {
        ...ZENGIN_ORIGINATOR,
        zengin: {
          clientCode: "12",
          clientName: "",
          bankCode: "bogus",
          branchCode: "",
          depositType: "9",
          accountNumber: "",
          bankName: "",
          branchName: "",
        },
      }),
    (error: Error) => error instanceof PaymentError && /Zengin originator settings are invalid/.test(error.message),
  );
});

test("a Zengin profile cannot render another format — the mismatch names zengin", () => {
  assert.throws(
    () =>
      renderPayRunBankFile(
        {
          format: "sepa",
          population: { entries: [], total: "0.0000", excludedCheque: [], excludedTotal: "0.0000" },
          credits: [],
        },
        {
          orgId: "org",
          documentId: "doc",
          format: "sepa",
          originator: ZENGIN_ORIGINATOR,
          messageId: "PBF-000007",
          fundsDate: "2026-08-21",
          createdAt: new Date(2026, 7, 14, 9, 30, 0),
        },
      ),
    (error: Error) => error instanceof PayrollError && /originates zengin, not sepa/.test(error.message),
  );
});

test("a sub-yen Zengin credit is refused rather than rounded into the trailer", () => {
  const inputs = zenginInputs();
  inputs.credits[0]!.amount = "250000.5000";
  // The population total tracks the credit so the test reaches the whole-yen
  // gate rather than the entries-total gate (which fires first, by design).
  inputs.population.total = "380233.5000";
  assert.throws(
    () => renderZengin(inputs),
    (error: Error) => error instanceof PayrollError && /whole number of yen/.test(error.message),
  );
});

test("a file total past the 10-digit yen field is refused, not silently unbalanced", () => {
  const inputs = zenginInputs();
  inputs.credits[0]!.amount = "99999999999.0000";
  inputs.population.total = "100000130232.0000";
  assert.throws(
    () => renderZengin(inputs),
    (error: Error) => error instanceof PaymentError && /does not fit in 10 digits/.test(error.message),
  );
});

test("a Zengin file with no readable trailer is refused, not tied to another rail's record", () => {
  assert.throws(
    () => readTrailerTotals("zengin", "9" + " ".repeat(119) + "\r\n"),
    (error: Error) => error instanceof PayrollError && /no readable trailer/.test(error.message),
  );
});

test("a run past the 200,000-record transmission cap is refused, never silently over-long", () => {
  const payments = Array.from({ length: 200_001 }, (_, i) => ({
    amountYen: 1000n,
    bankCode: "0005",
    branchCode: "110",
    depositType: "1",
    accountNumber: "8000001",
    payeeName: "ﾔﾏﾀﾞﾀﾛｳ",
    employeeNumber: `E${i}`,
  }));
  assert.throws(
    () =>
      buildZenginFile({
        settings: ZENGIN_ORIGINATOR.zengin!,
        transferDate: new Date("2026-08-21T00:00:00"),
        payments,
      }),
    (error: Error) => error instanceof PaymentError && /at most 200,000/.test(error.message),
  );
});

/* ------------------------------------------------------------------ */
/* Validators — the real pure functions, never doubles                  */
/* ------------------------------------------------------------------ */

test("normalizeBankCode and normalizeBranchCode resolve shaped codes and refuse the rest", () => {
  assert.equal(normalizeBankCode("0005"), "0005");
  assert.equal(normalizeBankCode(" 0005 "), "0005");
  assert.equal(normalizeBankCode("123"), null);
  assert.equal(normalizeBankCode("12345"), null);
  assert.equal(normalizeBankCode("ABCD"), null);
  assert.equal(normalizeBankCode(""), null);
  assert.equal(isValidBankCode("0005"), true);
  assert.equal(isValidBankCode("005"), false);
  assert.equal(normalizeBranchCode("110"), "110");
  assert.equal(normalizeBranchCode("12"), null);
  assert.equal(normalizeBranchCode("1234"), null);
  assert.equal(isValidBranchCode("110"), true);
  assert.equal(isValidBranchCode("11"), false);
});

test("normalizeZenginAccount zero-pads short numbers and refuses the inexpressible", () => {
  assert.equal(normalizeZenginAccount("1234567"), "1234567");
  assert.equal(normalizeZenginAccount("123456"), "0123456");
  assert.equal(normalizeZenginAccount("1"), "0000001");
  assert.equal(normalizeZenginAccount("123-4567"), "1234567");
  assert.equal(normalizeZenginAccount("12345678"), null);
  assert.equal(normalizeZenginAccount("ABCDEFG"), null);
  assert.equal(normalizeZenginAccount(""), null);
  assert.equal(normalizeZenginAccount("0000000"), null);
});

test("toZenginKana maps the mechanical readings and refuses kanji", () => {
  assert.equal(toZenginKana("エイディー"), "ｴｲﾃﾞｨｰ");
  assert.equal(toZenginKana("がぎぐげご"), "ｶﾞｷﾞｸﾞｹﾞｺﾞ");
  assert.equal(toZenginKana("やまだ"), "ﾔﾏﾀﾞ");
  assert.equal(toZenginKana("コンピューター"), "ｺﾝﾋﾟｭｰﾀｰ");
  assert.equal(toZenginKana("Ａｂｃ１２３"), "ABC123");
  assert.equal(toZenginKana("カ）ヤマダ"), "ｶ)ﾔﾏﾀﾞ");
  assert.equal(toZenginKana("ｱｲｳ"), "ｱｲｳ");
  assert.equal(toZenginKana("山田"), null);
  assert.equal(toZenginKana("Ａ山"), null);
});

test("validateZenginSettings accepts a complete originator and names every gap", () => {
  const good = validateZenginSettings({
    clientCode: "2012345678",
    clientName: "カ）ヤマダショウジ",
    bankCode: "0005",
    branchCode: "110",
    depositType: "1",
    accountNumber: "123456",
    bankName: "",
    branchName: "",
  });
  if (!good.ok) assert.fail(`expected a valid Zengin originator: ${good.missing.join(", ")}`);
  assert.deepEqual(good.settings, {
    clientCode: "2012345678",
    clientName: "ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ",
    bankCode: "0005",
    branchCode: "110",
    depositType: "1",
    accountNumber: "0123456",
    bankName: "",
    branchName: "",
  });
  const bad = validateZenginSettings({
    clientCode: "12",
    clientName: "山田商事",
    bankCode: "bogus",
    branchCode: "",
    depositType: "9",
    accountNumber: "",
  });
  if (bad.ok) assert.fail("a malformed Zengin originator must not validate");
  assert.match(bad.missing.join(", "), /clientCode/);
  assert.match(bad.missing.join(", "), /clientName/);
  assert.match(bad.missing.join(", "), /bankCode/);
  assert.match(bad.missing.join(", "), /depositType/);
});

test("optional kana bank names treat the unconfigured sentinel as omitted", () => {
  const withSentinel = validateZenginSettings({
    clientCode: "2012345678",
    clientName: "カ）ヤマダショウジ",
    bankCode: "0005",
    branchCode: "110",
    depositType: "1",
    accountNumber: "1234567",
    bankName: "FILL-ME",
    branchName: "FILL-ME",
  });
  if (!withSentinel.ok) assert.fail(`sentinel names must validate as omitted: ${withSentinel.missing.join(", ")}`);
  assert.equal(withSentinel.settings.bankName, "");
  assert.equal(withSentinel.settings.branchName, "");
});

/* ------------------------------------------------------------------ */
/* Rail reachability — the originator configuration the JP persona run  */
/* could not find (DB-gated; skipped in the unit partition)            */
/* ------------------------------------------------------------------ */

const DB = !!process.env.OPENBOOKS_DB_URL;

/** A scratch org with a zengin_credit bank profile carrying the given secrets. */
async function zenginProfileOrg(secrets: Record<string, unknown>) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  // The built-in ZENGIN-CREDIT format is JP-scoped and settles JPY — the same
  // definition AP would originate supplier payments on.
  await ensureBuiltInPaymentFormats(org.orgId, actorId);
  const formats = await db.execute<{ id: string }>(sql`
    select id from payment_formats where org_id = ${org.orgId} and rail = 'zengin_credit'`);
  assert.equal(formats.rows.length, 1);
  const bankAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${bankAccountId}, ${org.orgId}, '1090', 'Payroll funding bank', 'asset_bank', false, true,
            false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const profileId = randomUUID();
  await db.execute(sql`
    insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency,
                                       country, originator_secrets_encrypted, settings, is_active,
                                       created_by, updated_by)
    values (${profileId}, ${org.orgId}, 'Payroll direct deposit (Zengin)', ${bankAccountId}, ${formats.rows[0]!.id},
            'JPY', 'JP', ${sealJson(secrets)}, '{}'::jsonb, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, profileId };
}

test("a zengin_credit bank profile is listed for payroll and resolves its originator", { skip: !DB }, async () => {
  const fx = await zenginProfileOrg({
    clientCode: "2012345678",
    clientName: "カ）ヤマダショウジ",
    bankCode: "0005",
    branchCode: "110",
    depositType: "1",
    accountNumber: "1234567",
  });
  const profiles = await payrollBankProfiles(fx.orgId);
  const found = profiles.find((p) => p.id === fx.profileId);
  assert.ok(found);
  assert.equal(found.format, "zengin");
  assert.equal(found.currency, "JPY");
  assert.equal(found.configured, true);
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (!resolved.ok) assert.fail(`expected a resolved Zengin originator: ${resolved.missing.join(", ")}`);
  assert.equal(resolved.format, "zengin");
  assert.equal(resolved.config.currency, "JPY");
  assert.equal(resolved.config.zengin?.clientCode, "2012345678");
});
