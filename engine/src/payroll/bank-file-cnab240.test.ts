import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { createScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { PaymentError } from "../payments/payment-errors.ts";
import {
  buildCnab240BbFile,
  inscricaoTipoFor,
  isValidBancoCode,
  isValidContaDv,
  normalizeAgencia,
  normalizeContaNumero,
  normalizeCpfCnpj,
  validateCnab240BbSettings,
} from "../payments/rail-cnab240-bb.ts";
import {
  PAYROLL_BANK_FILE_FORMATS,
  payrollBankProfiles,
  payrollOriginatorConfig,
  readTrailerTotals,
  renderPayRunBankFile,
  resolveCnab240Creditor,
  type PayRunBankFileInputs,
  type PayrollOriginatorConfig,
} from "./bank-file.ts";
import { PayrollError } from "./error.ts";

/**
 * Payroll CNAB 240 disbursement — the Banco do Brasil variant.
 *
 * The name is `cnab240`, the rail `cnab240_bb_credit`, the currency BRL; BR
 * bank details are agência + conta (with check digits) plus a CPF/CNPJ
 * inscription — never an IBAN. The writer is the shared AP builder
 * (`buildCnab240BbFile`, engine/src/payments/rail-cnab240-bb.ts), whose
 * evidence log names every source with publisher, edition and date: two
 * bank-published manuals (Bradesco Multipag 2017, Banco Inter Pagamentos
 * 2025), the BB-manual-quoting Ruby transcription, a production folha
 * implementation, and OCA's production CNAB data for four banks. The money
 * bytes are five-sourced; the BB-flavored envelope choices fail loud at bank
 * validation — see the builder.
 *
 * Three things are under test and they differ in kind:
 *
 * 1. REUSE. Payroll must call the shared AP builder (`buildCnab240BbFile`),
 *    not carry a second CNAB implementation. The parity test asserts
 *    payroll's emitted bytes EQUAL the shared builder's output for the same
 *    inputs, and the worked-example test asserts the builder's bytes against
 *    the bank manuals' position tables (Bradesco Multipag pp.23–24 for
 *    Segmento A, p.22 for the lote header, p.14 for the arquivo header).
 * 2. THE GOLDEN. The emitted bytes asserted character for character: header
 *    de arquivo, a forma-01 lote (same-bank employee, câmara 000) and a
 *    forma-41 lote (TED employee, câmara 018) each with A+B pairs and a
 *    trailer, then the trailer de arquivo — CRLF-terminated, every record
 *    exactly 240 characters.
 * 3. REFUSAL. An employee row without shaped bank coordinates or a
 *    check-digit-valid CPF/CNPJ is a named refusal with the cheque remedy —
 *    never silently dropped, never coerced (a coerced agência pays a
 *    stranger); the whole file refuses rather than paying some and dropping
 *    another.
 *
 * All tests here are pure (no database) except the rail-reachability tests at
 * the end: the render path takes every input explicitly, which is what makes
 * the stored artifact reproducible evidence.
 */

const CNAB_ORIGINATOR: PayrollOriginatorConfig = {
  paymentBankProfileId: "55555555-5555-4555-8555-555555555555",
  profileName: "Payroll direct deposit (CNAB 240 BB)",
  format: "cnab240",
  currency: "BRL",
  lineEnding: "crlf",
  cnab240bb: {
    cnpjEmpresa: "12345678000195",
    convenio: "123456789",
    agencia: "1234",
    agenciaDv: "0",
    conta: "123456",
    contaDv: "1",
    nomeEmpresa: "EMPRESA EXEMPLO LTDA",
    versaoLayoutArquivo: "084",
  },
};

const cnabInputs = (): PayRunBankFileInputs => ({
  format: "cnab240",
  population: {
    entries: [],
    total: "4321.5000",
    excludedCheque: [
      { employeePartyId: "p3", employeeName: "CY OVERRIDE", amount: "900.0000", reason: "profile" },
    ],
    excludedTotal: "900.0000",
  },
  credits: [
    {
      stubId: "s1", employeePartyId: "p1", employeeName: "ADA AZEVEDO", amount: "2500.0000",
      employeeNumber: "EMP-0001",
      routing: { banco: "001", agencia: "4321", agenciaDv: "2", contaDv: "3", cpfCnpj: "11144477735" },
      accountNumber: "987654",
      cnab240: {
        bancoFavorecido: "001", agencia: "04321", agenciaDv: "2", contaDv: "3", dac: null,
        inscricaoTipo: "1", inscricaoNumero: "11144477735",
      },
    },
    {
      stubId: "s2", employeePartyId: "p2", employeeName: "BO BRAGA", amount: "1821.5000",
      employeeNumber: "EMP-0002",
      routing: { banco: "237", agencia: "123", agenciaDv: "4", contaDv: "5", cpfCnpj: "12345678909" },
      accountNumber: "1234567",
      cnab240: {
        bancoFavorecido: "237", agencia: "00123", agenciaDv: "4", contaDv: "5", dac: null,
        inscricaoTipo: "1", inscricaoNumero: "12345678909",
      },
    },
  ],
});

const renderCnab = (inputs = cnabInputs(), originator = CNAB_ORIGINATOR) =>
  renderPayRunBankFile(inputs, {
    orgId: "org",
    documentId: "doc",
    format: "cnab240",
    originator,
    cnabNsa: "000007",
    // The payment date backs Segmento A 94–101 (DDMMAAAA).
    fundsDate: "2026-08-21",
    createdAt: new Date(2026, 7, 14, 9, 30, 0),
  });

/* ------------------------------------------------------------------ */
/* Format registration                                                 */
/* ------------------------------------------------------------------ */

test("the CNAB 240 format is registered, enabled, and settled in BRL on the cnab240_bb_credit rail", () => {
  const spec = PAYROLL_BANK_FILE_FORMATS.cnab240;
  assert.equal(spec.enabled, true);
  assert.equal(spec.currency, "BRL");
  assert.deepEqual(spec.rails, ["cnab240_bb_credit"]);
  assert.equal(spec.extension, "rem");
  assert.equal(spec.contentType, "text/plain; charset=us-ascii");
  assert.equal(spec.disabledReason, undefined);
});

/* ------------------------------------------------------------------ */
/* Golden file — the emitted bytes, character for character             */
/* ------------------------------------------------------------------ */

/**
 * The golden document, written literally field by field against the
 * bank-published position tables (Bradesco Multipag pp.14–15, 22–24, 28):
 *
 * Header de arquivo: "001" | "0000" | "0" | 9 blanks | "2" + CNPJ
 * 12345678000195 | convênio "123456789" + "0126" + 7 blanks | agência
 * "01234" + DV "0" | conta "000000123456" + DV "1" + "0" | company name |
 * "BANCO DO BRASIL" | 10 blanks | "1" | "14082026" | "093000" | NSA
 * "000007" | layout "084" | "00000" | blanks to 240.
 *
 * Header de lote: "001" | lote | "1" | "C" | "30" (Pagamento de Salários) |
 * forma ("01" same-bank, "41" TED) | "045" | blank | "2" + CNPJ | convênio
 * block | debit account block | company name | 40 + 80 + 8 blanks |
 * 10 blanks.
 *
 * Segmento A: "001" | lote | "3" | seq | "A" | "0" | "00" | câmara ("000" /
 * "018") | banco ("001" / "237") | agência + DV | conta (12) + DV + DAC |
 * nome (30) | "PAY EMP-000n" | "21082026" | "BRL" | 15 zeros | valor 13+2 |
 * 20 blanks | 8 + 15 zeros | 40 + 2 + 5 + 2 + 3 blanks | "0" | 10 blanks.
 *
 * Segmento B: "001" | lote | "3" | seq | "B" | 3 blanks | "1" + CPF
 * zero-padded to 14 | 193 blanks | "0" | 14 blanks.
 *
 * Trailer de lote: "001" | lote | "5" | 9 blanks | count (header + details
 * + trailer) | P007 somatória 16+2 | 18 + 6 + 165 blanks | 10 blanks.
 *
 * Trailer de arquivo: "001" | "9999" | "9" | 9 blanks | lote count |
 * whole-file record count | 6 zeros | 205 blanks.
 */
const CNAB_GOLDEN =
  "00100000         2123456780001951234567890126       01234000000012345610EMPRESA EXEMPLO LTDA          BANCO DO BRASIL                         11408202609300000000708400000                                                                     \r\n" +
  "00100011C3001045 2123456780001951234567890126       01234000000012345610EMPRESA EXEMPLO LTDA                                                                                                                                                    \r\n" +
  "0010001300001A0000000010432120000009876543 ADA AZEVEDO                   PAY EMP-0001        21082026BRL000000000000000000000000250000                    00000000000000000000000                                                    0          \r\n" +
  "0010001300002B   100011144477735                                                                                                                                                                                                 0              \r\n" +
  "00100015         000004000000000000250000                                                                                                                                                                                                       \r\n" +
  "00100021C3041045 2123456780001951234567890126       01234000000012345610EMPRESA EXEMPLO LTDA                                                                                                                                                    \r\n" +
  "0010002300001A0000182370012340000012345675 BO BRAGA                      PAY EMP-0002        21082026BRL000000000000000000000000182150                    00000000000000000000000                                                    0          \r\n" +
  "0010002300002B   100012345678909                                                                                                                                                                                                 0              \r\n" +
  "00100025         000004000000000000182150                                                                                                                                                                                                       \r\n" +
  "00199999         000002000010000000                                                                                                                                                                                                             \r\n";

test("CNAB 240 golden file — byte for byte against the bank-published position tables", () => {
  const result = renderCnab();
  assert.equal(result.content, CNAB_GOLDEN);
  assert.equal(result.contentType, "text/plain; charset=us-ascii");
  assert.equal(result.extension, "rem");
  assert.equal(result.currency, "BRL");
});

test("every golden record is 240 characters with the terminator outside", () => {
  const result = renderCnab();
  assert.ok(result.content.endsWith("\r\n"));
  const records = result.content.split("\r\n").filter((line) => line.length > 0);
  assert.equal(records.length, 10);
  for (const record of records) assert.equal(record.length, 240);
  // tipo de registro at position 8: 0 header, 1 lote header, 3 details, 5 lote trailer, 9 arquivo trailer.
  assert.deepEqual(records.map((r) => r[7]).join(""), "0133" + "5" + "133" + "5" + "9");
  assert.equal(records[0]!.slice(3, 7), "0000");
  assert.equal(records[9]!.slice(3, 7), "9999");
});

test("the golden header de arquivo carries the convênio, debit account, NSA and layout version at their offsets", () => {
  const header = renderCnab().content.split("\r\n")[0]!;
  assert.equal(header.slice(0, 3), "001");
  assert.equal(header.slice(17, 18), "2");
  assert.equal(header.slice(18, 32), "12345678000195");
  assert.equal(header.slice(32, 41), "123456789");
  assert.equal(header.slice(41, 45), "0126");
  assert.equal(header.slice(52, 57), "01234");
  assert.equal(header.slice(57, 58), "0");
  assert.equal(header.slice(58, 70), "000000123456");
  assert.equal(header.slice(70, 72), "10");
  assert.equal(header.slice(72, 102), "EMPRESA EXEMPLO LTDA".padEnd(30, " "));
  assert.equal(header.slice(142, 143), "1");
  assert.equal(header.slice(143, 151), "14082026");
  assert.equal(header.slice(151, 157), "093000");
  assert.equal(header.slice(157, 163), "000007");
  assert.equal(header.slice(163, 166), "084");
  assert.equal(header.slice(166, 171), "00000");
});

test("same-bank and TED credits ride separate lotes with their own forma, câmara and trailer totals", () => {
  const records = renderCnab().content.split("\r\n").filter((line) => line.length > 0);
  const lote1Header = records[1]!;
  const lote2Header = records[5]!;
  // 9:C operação, 10–11 tipo 30 (salários), 12–13 forma, 14–16 lote layout 045.
  assert.equal(lote1Header.slice(8, 9), "C");
  assert.equal(lote1Header.slice(9, 11), "30");
  assert.equal(lote1Header.slice(11, 13), "01");
  assert.equal(lote1Header.slice(13, 16), "045");
  assert.equal(lote2Header.slice(11, 13), "41");
  // Segmento A 18–20 câmara, 21–23 banco favorecido.
  assert.equal(records[2]!.slice(17, 20), "000");
  assert.equal(records[2]!.slice(20, 23), "001");
  assert.equal(records[6]!.slice(17, 20), "018");
  assert.equal(records[6]!.slice(20, 23), "237");
  // Trailer de lote: 18–23 record count (header + A + B + trailer), 24–41 P007.
  assert.equal(records[4]!.slice(17, 23), "000004");
  assert.equal(records[4]!.slice(23, 41), "000000000000250000");
  assert.equal(records[8]!.slice(17, 23), "000004");
  assert.equal(records[8]!.slice(23, 41), "000000000000182150");
  // Trailer de arquivo: 18–23 lote count, 24–29 whole-file record count.
  assert.equal(records[9]!.slice(17, 23), "000002");
  assert.equal(records[9]!.slice(23, 29), "000010");
  assert.deepEqual(readTrailerTotals("cnab240", renderCnab().content), { totalCents: 432150n, count: 2 });
});

test("the golden Segmento A money bytes sit at the manual's offsets", () => {
  const records = renderCnab().content.split("\r\n").filter((line) => line.length > 0);
  const segA = records[2]!;
  // Bradesco Multipag p.23: 24–28 agência, 29 DV, 30–41 conta, 42 DV, 43 DAC,
  // 44–73 nome, 74–93 seu número, 94–101 data, 102–104 moeda, 105–119 zeros,
  // 120–134 valor 13+2, 230 aviso.
  assert.equal(segA.slice(23, 28), "04321");
  assert.equal(segA.slice(28, 29), "2");
  assert.equal(segA.slice(29, 41), "000000987654");
  assert.equal(segA.slice(41, 42), "3");
  assert.equal(segA.slice(42, 43), " ");
  assert.equal(segA.slice(43, 73), "ADA AZEVEDO".padEnd(30, " "));
  assert.equal(segA.slice(73, 93), "PAY EMP-0001".padEnd(20, " "));
  assert.equal(segA.slice(93, 101), "21082026");
  assert.equal(segA.slice(101, 104), "BRL");
  assert.equal(segA.slice(104, 119), "0".repeat(15));
  assert.equal(segA.slice(119, 134), "000000000250000");
  assert.equal(segA.slice(229, 230), "0");
  // Segmento B: 18 inscrição tipo, 19–32 CPF zero-padded to 14.
  const segB = records[3]!;
  assert.equal(segB.slice(13, 14), "B");
  assert.equal(segB.slice(17, 18), "1");
  assert.equal(segB.slice(18, 32), "00011144477735");
});

/* ------------------------------------------------------------------ */
/* The independent worked example — every data offset, field by field   */
/* ------------------------------------------------------------------ */

/**
 * The Bradesco Multipag manual's own position tables (pp.23–24) are the
 * worked example here: this test feeds fresh inputs through the shared
 * builder and asserts the same slices the manual publishes — a lookalike
 * with a shifted layout cannot pass it, and agreement here is agreement
 * between two independent transcriptions (the manual and this writer), not
 * with ourselves.
 */
test("the manual's Segmento A positions reproduce through the shared builder", () => {
  const mine = buildCnab240BbFile({
    settings: CNAB_ORIGINATOR.cnab240bb!,
    nsa: "000001",
    creationDate: new Date(2026, 7, 14, 9, 30, 0),
    paymentDate: new Date(2026, 7, 21, 0, 0, 0),
    payments: [{
      amountCents: 150050n,
      bancoFavorecido: "341",
      agencia: "7777",
      agenciaDv: "1",
      conta: "12345678",
      contaDv: "9",
      dac: null,
      favorecidoNome: "Beneficiaria SA",
      inscricaoTipo: "2",
      inscricaoNumero: "11222333000181",
      seuNumero: "NF-1001",
    }],
  });
  const lines = mine.split("\r\n").filter((line) => line.length > 0);
  // Single TED payment: header arquivo + header lote + A + B + trailer lote + trailer arquivo.
  assert.equal(lines.length, 6);
  const segA = lines[2]!;
  assert.equal(segA.slice(7, 8), "3");
  assert.equal(segA.slice(13, 14), "A");
  assert.equal(segA.slice(14, 15), "0");
  assert.equal(segA.slice(15, 17), "00");
  assert.equal(segA.slice(17, 20), "018");
  assert.equal(segA.slice(20, 23), "341");
  assert.equal(segA.slice(23, 28), "07777");
  assert.equal(segA.slice(28, 29), "1");
  assert.equal(segA.slice(29, 41), "000012345678");
  assert.equal(segA.slice(41, 42), "9");
  assert.equal(segA.slice(43, 73), "BENEFICIARIA SA".padEnd(30, " "));
  assert.equal(segA.slice(73, 93), "NF-1001".padEnd(20, " "));
  assert.equal(segA.slice(119, 134), "000000000150050");
  const segB = lines[3]!;
  assert.equal(segB.slice(17, 18), "2");
  assert.equal(segB.slice(18, 32), "11222333000181");
  // One lote, one credit: the P007 somatória ties to the single payment.
  assert.equal(lines[4]!.slice(23, 41), "000000000000150050");
  assert.deepEqual(readTrailerTotals("cnab240", mine), { totalCents: 150050n, count: 1 });
});

/* ------------------------------------------------------------------ */
/* Parity — payroll's bytes ARE the shared builder's bytes              */
/* ------------------------------------------------------------------ */

test("payroll's CNAB 240 output equals the shared AP builder's output for the same inputs", () => {
  const viaPayroll = renderCnab().content;
  // The same mapping payroll applies, written out longhand. If payroll ever
  // forks its own CNAB writer, this diverges.
  const viaSharedBuilder = buildCnab240BbFile({
    settings: CNAB_ORIGINATOR.cnab240bb!,
    nsa: "000007",
    creationDate: new Date(2026, 7, 14, 9, 30, 0),
    paymentDate: new Date(2026, 7, 21, 0, 0, 0),
    payments: [
      {
        amountCents: 250000n,
        bancoFavorecido: "001",
        agencia: "04321",
        agenciaDv: "2",
        conta: "987654",
        contaDv: "3",
        dac: null,
        favorecidoNome: "ADA AZEVEDO",
        inscricaoTipo: "1",
        inscricaoNumero: "11144477735",
        seuNumero: "PAY EMP-0001",
      },
      {
        amountCents: 182150n,
        bancoFavorecido: "237",
        agencia: "00123",
        agenciaDv: "4",
        conta: "1234567",
        contaDv: "5",
        dac: null,
        favorecidoNome: "BO BRAGA",
        inscricaoTipo: "1",
        inscricaoNumero: "12345678909",
        seuNumero: "PAY EMP-0002",
      },
    ],
  });
  assert.equal(viaPayroll, viaSharedBuilder);
});

/* ------------------------------------------------------------------ */
/* Channel text — accents strip deterministically, never shift fields   */
/* ------------------------------------------------------------------ */

test("accented names map to the channel without shifting any field", () => {
  const inputs = cnabInputs();
  inputs.credits[0]!.employeeName = "JOSÉ AÇÃO";
  const segA = renderCnab(inputs).content.split("\r\n").filter((l) => l.length > 0)[2]!;
  assert.equal(segA.length, 240);
  assert.equal(segA.slice(43, 73), "JOSE ACAO".padEnd(30, " "));
});

test("a second TED check digit rides position 43 verbatim, blank otherwise", () => {
  const inputs = cnabInputs();
  inputs.credits[1]!.cnab240 = { ...inputs.credits[1]!.cnab240!, dac: "7" };
  const records = renderCnab(inputs).content.split("\r\n").filter((l) => l.length > 0);
  assert.equal(records[6]!.slice(42, 43), "7");
  assert.equal(records[2]!.slice(42, 43), " ");
});

/* ------------------------------------------------------------------ */
/* Refusal — unusable bank details refuse the whole file                */
/* ------------------------------------------------------------------ */

test("a missing bank code names the employee and the cheque fallback", () => {
  const resolved = resolveCnab240Creditor("ADA AZEVEDO", { agencia: "4321", agenciaDv: "2", contaDv: "3", cpfCnpj: "11144477735" }, "987654");
  if (resolved.ok) assert.fail("a missing bank code must not resolve");
  assert.match(resolved.reason, /ADA AZEVEDO/);
  assert.match(resolved.reason, /3-digit bank code/);
  assert.match(resolved.reason, /cheque/);
});

test("a malformed bank code is refused — an IBAN is not a bank code", () => {
  for (const bad of ["1", "0001", "ABC", "", "BR001"]) {
    const resolved = resolveCnab240Creditor(
      "ADA AZEVEDO",
      { banco: bad, agencia: "4321", agenciaDv: "2", contaDv: "3", cpfCnpj: "11144477735" },
      "987654",
    );
    if (resolved.ok) assert.fail(`bank code "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA AZEVEDO/);
  }
});

test("an unshaped agência or conta is refused, never truncated into another account", () => {
  for (const agencia of ["123456", "ABCD", ""]) {
    const resolved = resolveCnab240Creditor(
      "ADA AZEVEDO",
      { banco: "001", agencia, agenciaDv: "2", contaDv: "3", cpfCnpj: "11144477735" },
      "987654",
    );
    if (resolved.ok) assert.fail(`agência "${agencia}" must not resolve`);
    assert.match(resolved.reason, /ADA AZEVEDO/);
  }
  for (const conta of ["1234567890123", "ABC", ""]) {
    const resolved = resolveCnab240Creditor(
      "ADA AZEVEDO",
      { banco: "001", agencia: "4321", agenciaDv: "2", contaDv: "3", cpfCnpj: "11144477735" },
      conta,
    );
    if (resolved.ok) assert.fail(`conta "${conta}" must not resolve`);
    assert.match(resolved.reason, /ADA AZEVEDO/);
  }
});

test("a missing check digit is refused rather than zero-filled into a wrong one", () => {
  const noAgDv = resolveCnab240Creditor(
    "ADA AZEVEDO",
    { banco: "001", agencia: "4321", contaDv: "3", cpfCnpj: "11144477735" },
    "987654",
  );
  if (noAgDv.ok) assert.fail("a missing agência DV must not resolve");
  assert.match(noAgDv.reason, /check digit/);
  const noContaDv = resolveCnab240Creditor(
    "ADA AZEVEDO",
    { banco: "001", agencia: "4321", agenciaDv: "2", cpfCnpj: "11144477735" },
    "987654",
  );
  if (noContaDv.ok) assert.fail("a missing conta DV must not resolve");
  assert.match(noContaDv.reason, /check digit/);
});

test("a CPF with a wrong check digit is refused — the bank's confrontation would reject it", () => {
  for (const bad of ["11144477736", "11111111111", "123", ""]) {
    const resolved = resolveCnab240Creditor(
      "ADA AZEVEDO",
      { banco: "001", agencia: "4321", agenciaDv: "2", contaDv: "3", cpfCnpj: bad },
      "987654",
    );
    if (resolved.ok) assert.fail(`inscription "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA AZEVEDO/);
    assert.match(resolved.reason, /CPF/);
  }
});

test("a formatted CPF canonicalizes to digits — punctuation is formatting, not identity", () => {
  const resolved = resolveCnab240Creditor(
    "ADA AZEVEDO",
    { banco: "001", agencia: "4321", agenciaDv: "2", contaDv: "3", cpfCnpj: "111.444.777-35" },
    "987654",
  );
  if (!resolved.ok) assert.fail(`a formatted CPF must resolve: ${resolved.reason}`);
  assert.equal(resolved.address.inscricaoNumero, "11144477735");
  assert.equal(resolved.address.inscricaoTipo, "1");
});

test("a valid CNPJ resolves as pessoa jurídica", () => {
  const resolved = resolveCnab240Creditor(
    "FORNECEDORA SA",
    { banco: "237", agencia: "123", agenciaDv: "4", contaDv: "5", cpfCnpj: "11.222.333/0001-81" },
    "1234567",
  );
  if (!resolved.ok) assert.fail(`a valid CNPJ must resolve: ${resolved.reason}`);
  assert.equal(resolved.address.inscricaoTipo, "2");
  assert.equal(resolved.address.inscricaoNumero, "11222333000181");
});

test("a credit that reaches the renderer without a resolved address is refused, not emitted", () => {
  const inputs = cnabInputs();
  delete (inputs.credits[0] as { cnab240?: unknown }).cnab240;
  assert.throws(
    () => renderCnab(inputs),
    (error: Error) =>
      error instanceof PayrollError && /ADA AZEVEDO.*no validated destino address/.test(error.message),
  );
});

test("an unconfigured CNAB originator is refused by name rather than emitting bytes the bank misreads", () => {
  assert.throws(
    () =>
      renderCnab(cnabInputs(), {
        ...CNAB_ORIGINATOR,
        cnab240bb: {
          cnpjEmpresa: "bogus",
          convenio: "12",
          agencia: "",
          agenciaDv: "",
          conta: "",
          contaDv: "",
          nomeEmpresa: "",
          versaoLayoutArquivo: "",
        },
      }),
    (error: Error) => error instanceof PaymentError && /CNAB 240 originator settings are invalid/.test(error.message),
  );
});

test("a CNAB profile cannot render another format — the mismatch names cnab240", () => {
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
          originator: CNAB_ORIGINATOR,
          messageId: "PBF-000007",
          fundsDate: "2026-08-21",
          createdAt: new Date(2026, 7, 14, 9, 30, 0),
        },
      ),
    (error: Error) => error instanceof PayrollError && /originates cnab240, not sepa/.test(error.message),
  );
});

test("CNAB 240 requires its allocated NSA — never re-derived", () => {
  assert.throws(
    () =>
      renderPayRunBankFile(cnabInputs(), {
        orgId: "org",
        documentId: "doc",
        format: "cnab240",
        originator: CNAB_ORIGINATOR,
        fundsDate: "2026-08-21",
        createdAt: new Date(2026, 7, 14, 9, 30, 0),
      }),
    (error: Error) => error instanceof PayrollError && /allocated NSA/.test(error.message),
  );
});

test("a sub-cent CNAB credit is refused rather than truncated into the trailer", () => {
  const inputs = cnabInputs();
  inputs.credits[0]!.amount = "2500.0050";
  // The population total tracks the credit so the test reaches the sub-cent
  // gate rather than the entries-total gate (which fires first, by design).
  inputs.population.total = "4321.5050";
  assert.throws(
    () => renderCnab(inputs),
    (error: Error) => error instanceof PayrollError && /whole number of cents/.test(error.message),
  );
});

test("a file total past the 15-digit centavos field is refused, not silently unbalanced", () => {
  const inputs = cnabInputs();
  inputs.credits[0]!.amount = "99999999999999.9900";
  inputs.population.total = "100000000001821.4900";
  assert.throws(
    () => renderCnab(inputs),
    // Thrown by the shared writer (PaymentError), not the payroll render:
    // what matters is the refusal text the operator reads.
    (error: Error) => error instanceof Error && /does not fit in 15 digits/.test(error.message),
  );
});

test("a CNAB file with no readable trailer de arquivo is refused, not tied to another rail's record", () => {
  assert.throws(
    () => readTrailerTotals("cnab240", "00100000" + " ".repeat(232) + "\r\n"),
    (error: Error) => error instanceof PayrollError && /no readable trailer de arquivo/.test(error.message),
  );
});

/* ------------------------------------------------------------------ */
/* Validators — the real pure functions, never doubles                  */
/* ------------------------------------------------------------------ */

test("normalizeAgencia pads to five and refuses the unshaped", () => {
  assert.equal(normalizeAgencia("1234"), "01234");
  assert.equal(normalizeAgencia("01234"), "01234");
  assert.equal(normalizeAgencia("123456"), null);
  assert.equal(normalizeAgencia("ABCD"), null);
  assert.equal(normalizeAgencia(""), null);
  assert.equal(normalizeAgencia("00000"), null);
});

test("normalizeContaNumero pads to twelve and refuses the unshaped", () => {
  assert.equal(normalizeContaNumero("987654"), "000000987654");
  assert.equal(normalizeContaNumero("000000987654"), "000000987654");
  assert.equal(normalizeContaNumero("1234567890123"), null);
  assert.equal(normalizeContaNumero("ABC"), null);
  assert.equal(normalizeContaNumero(""), null);
  assert.equal(normalizeContaNumero("000000000000"), null);
  assert.equal(isValidBancoCode("001"), true);
  assert.equal(isValidBancoCode("237"), true);
  assert.equal(isValidBancoCode("0001"), false);
  assert.equal(isValidContaDv("3"), true);
  assert.equal(isValidContaDv("X"), true);
  assert.equal(isValidContaDv(""), false);
  assert.equal(isValidContaDv("12"), false);
});

test("normalizeCpfCnpj checks the módulo-11 digits instead of trusting shape", () => {
  assert.equal(normalizeCpfCnpj("11144477735"), "11144477735");
  assert.equal(normalizeCpfCnpj("111.444.777-35"), "11144477735");
  assert.equal(normalizeCpfCnpj("12345678909"), "12345678909");
  assert.equal(normalizeCpfCnpj("11222333000181"), "11222333000181");
  assert.equal(normalizeCpfCnpj("11.222.333/0001-81"), "11222333000181");
  assert.equal(normalizeCpfCnpj("11144477736"), null);
  assert.equal(normalizeCpfCnpj("11111111111"), null);
  assert.equal(normalizeCpfCnpj("00000000000000"), null);
  assert.equal(normalizeCpfCnpj("11222333000182"), null);
  assert.equal(normalizeCpfCnpj("123"), null);
  assert.equal(inscricaoTipoFor("11144477735"), "1");
  assert.equal(inscricaoTipoFor("11222333000181"), "2");
  assert.equal(inscricaoTipoFor("123"), null);
});

test("validateCnab240BbSettings accepts a complete originator and names every gap", () => {
  const good = validateCnab240BbSettings({
    cnpjEmpresa: "12.345.678/0001-95",
    convenio: "123456789",
    agencia: "1234",
    agenciaDv: "0",
    conta: "123456",
    contaDv: "1",
    nomeEmpresa: "EMPRESA EXEMPLO LTDA",
    versaoLayoutArquivo: "084",
  });
  if (!good.ok) assert.fail(`expected a valid CNAB originator: ${good.missing.join(", ")}`);
  assert.deepEqual(good.settings, {
    cnpjEmpresa: "12345678000195",
    convenio: "123456789",
    agencia: "1234",
    agenciaDv: "0",
    conta: "123456",
    contaDv: "1",
    nomeEmpresa: "EMPRESA EXEMPLO LTDA",
    versaoLayoutArquivo: "084",
  });
  const bad = validateCnab240BbSettings({
    cnpjEmpresa: "bogus",
    convenio: "12",
    agencia: "",
    agenciaDv: "",
    conta: "",
    contaDv: "",
    nomeEmpresa: "",
    versaoLayoutArquivo: "",
  });
  if (bad.ok) assert.fail("a malformed CNAB originator must not validate");
  assert.match(bad.missing.join(", "), /cnpjEmpresa/);
  assert.match(bad.missing.join(", "), /convenio/);
  assert.match(bad.missing.join(", "), /versaoLayoutArquivo/);
});

/* ------------------------------------------------------------------ */
/* Rail reachability — the originator configuration the BR persona run  */
/* could not find (DB-gated; skipped in the unit partition)            */
/* ------------------------------------------------------------------ */

const DB = !!process.env.OPENBOOKS_DB_URL;

/** A scratch org with a cnab240_bb_credit bank profile carrying the given secrets. */
async function cnabProfileOrg(secrets: Record<string, unknown>) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const bankAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${bankAccountId}, ${org.orgId}, '1090', 'Payroll funding bank', 'asset_bank', false, true,
            false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  // The built-in CNAB240BB-CREDIT format is BR-scoped and settles BRL — the
  // same definition AP would originate supplier payments on.
  const formatId = randomUUID();
  await db.execute(sql`
    insert into payment_formats (id, org_id, code, name, rail, direction, country, currency,
                                 file_extension, content_type, settings, is_active, created_by, updated_by)
    values (${formatId}, ${org.orgId}, 'CNAB240BB-CREDIT', 'CNAB 240 Banco do Brasil credit transfer', 'cnab240_bb_credit', 'credit',
            'BR', 'BRL', 'rem', 'text/plain; charset=us-ascii', '{}'::jsonb, true, ${actorId}, ${actorId})`);
  const profileId = randomUUID();
  await db.execute(sql`
    insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency,
                                       country, originator_secrets_encrypted, settings, is_active,
                                       created_by, updated_by)
    values (${profileId}, ${org.orgId}, 'Payroll direct deposit (CNAB 240 BB)', ${bankAccountId}, ${formatId},
            'BRL', 'BR', ${sealJson(secrets)}, '{}'::jsonb, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, profileId };
}

test("a cnab240_bb_credit bank profile is listed for payroll and resolves its originator", { skip: !DB }, async () => {
  const fx = await cnabProfileOrg({
    cnpjEmpresa: "12345678000195",
    convenio: "123456789",
    agencia: "1234",
    agenciaDv: "0",
    conta: "123456",
    contaDv: "1",
    nomeEmpresa: "EMPRESA EXEMPLO LTDA",
    versaoLayoutArquivo: "084",
  });
  // Reachable: the operator's picker sees the profile, on the cnab240 format,
  // fully configured — the "No originating bank profile is set up" dead end
  // from the BR persona run is gone for this rail.
  const profiles = await payrollBankProfiles(fx.orgId);
  assert.deepEqual(
    profiles.map((p) => ({ name: p.name, format: p.format, currency: p.currency, configured: p.configured })),
    [{
      name: "Payroll direct deposit (CNAB 240 BB)",
      format: "cnab240",
      currency: "BRL",
      configured: true,
    }],
  );
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (!resolved.ok) assert.fail(`expected a configured CNAB originator: ${resolved.missing.join(", ")}`);
  assert.equal(resolved.format, "cnab240");
  assert.equal(resolved.config.currency, "BRL");
  assert.deepEqual(resolved.config.cnab240bb, {
    cnpjEmpresa: "12345678000195",
    convenio: "123456789",
    agencia: "1234",
    agenciaDv: "0",
    conta: "123456",
    contaDv: "1",
    nomeEmpresa: "EMPRESA EXEMPLO LTDA",
    versaoLayoutArquivo: "084",
  });
});

test("a cnab240 profile with a malformed convênio is listed as not configured, naming it", { skip: !DB }, async () => {
  const fx = await cnabProfileOrg({
    cnpjEmpresa: "12345678000195",
    convenio: "bogus",
    agencia: "1234",
    agenciaDv: "0",
    conta: "123456",
    contaDv: "1",
    nomeEmpresa: "EMPRESA EXEMPLO LTDA",
    versaoLayoutArquivo: "084",
  });
  const profiles = await payrollBankProfiles(fx.orgId);
  assert.equal(profiles[0]?.configured, false);
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (resolved.ok) assert.fail("a malformed convênio must not resolve");
  assert.match(resolved.missing.join(", "), /convenio/);
});
