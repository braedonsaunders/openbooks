import assert from "node:assert/strict";
import test from "node:test";
import { BankingError, parseBai2, parseCsv } from "./banking.ts";

const baiHeader = "02,ORG,1,1,260821,0000,CAD,2/";

test("BAI2 rejects amount fields containing anything beyond an optional sign and digits", () => {
  for (const amount of ["12X34", "12-34", "12.34", ""]) {
    const source = [baiHeader, `16,165,${amount},S,REF,,deposit/`].join("\n");
    assert.throws(
      () => parseBai2(source),
      (error: unknown) =>
        error instanceof BankingError && /unparseable amount/.test(error.message),
      `expected malformed BAI2 amount ${JSON.stringify(amount)} to be rejected`,
    );
  }
});

test("BAI2 preserves the sign on exact integer-cent amounts", () => {
  const parsed = parseBai2(
    [
      baiHeader,
      "16,165,+150000,S,REF,,deposit/",
      "16,495,-500,S,REF2,,withdrawal/",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.lines.map((line) => line.amount),
    ["1500.0000", "-5.0000"],
  );
});

test("human statement amounts refuse a lone comma two locales could read differently", () => {
  // "1,234" is 1234 in a grouping locale and 1.234 in a decimal-comma one.
  // The old parse silently picked grouping — a 1000x line for every
  // decimal-comma feed — so the ambiguous shape is refused with BOTH
  // readings named, through the same shared classifier the payroll
  // decimal boundary uses.
  const cases: Array<[raw: string, grouped: string, dotted: string]> = [
    ["1,234", "1234", "1.234"],
    ["12,345", "12345", "12.345"],
    ["123,456", "123456", "123.456"],
  ];
  for (const [raw, grouped, dotted] of cases) {
    const source = `date,amount,description\n2026-07-01,"${raw}",salary\n`;
    assert.throws(
      () => parseCsv(source, { date: 0, amount: 1, description: 2 }),
      (error: unknown) =>
        error instanceof BankingError &&
        error.message.includes(`could mean ${grouped} (thousands separator) or ${dotted} (decimal comma)`),
      `expected ${raw} to be refused naming both readings`,
    );
  }
});

test("a leading disclaimer row is reported as skipped, never silently dropped", () => {
  // A bank CSV with a metadata row on top used to lose that row silently:
  // its date failed, so it was sliced off as the header and the import
  // agreed with the loss. The row is now reported by line number with a
  // reason code (locales render the sentence; no English prose crosses).
  const parsed = parseCsv(
    "Bank export - confidential\n2026-07-01,12.50,salary\n2026-07-02,-5.00,coffee\n",
    { date: 0, amount: 1, description: 2 },
  );
  assert.deepEqual(
    parsed.lines.map((line) => line.amount),
    ["12.5000", "-5.0000"],
  );
  assert.deepEqual(parsed.skipped, [
    { line: 1, code: "csv_metadata_row", dateCell: "Bank export - confidential" },
  ]);
});

test("an ordinary column-header row is consumed, never warned about", () => {
  // The header used to land in `skipped`, so nearly every CSV import showed
  // the amber "1 source row was set aside" warning — training operators to
  // ignore it. A row whose mapped amount column holds a label (not a
  // number) beside a description is the header in ANY language: numericity,
  // not vocabulary, is the test, so the German header classifies alike.
  for (const header of ["Date,Amount,Description", "Datum,Betrag,Beschreibung"]) {
    const parsed = parseCsv(
      `${header}\n2026-07-01,12.50,salary\n2026-07-02,-5.00,coffee\n`,
      { date: 0, amount: 1, description: 2 },
    );
    assert.deepEqual(
      parsed.lines.map((line) => line.amount),
      ["12.5000", "-5.0000"],
      `header ${JSON.stringify(header)} must parse without warnings`,
    );
    assert.deepEqual(parsed.skipped, [], `header ${JSON.stringify(header)} must not warn`);
  }
});

test("a metadata preamble before the header reports each disclaimer row", () => {
  // Bank exports with leading metadata rows used to die on the real header
  // ("unparseable date 'Date'"): only row 1 was ever classified. The whole
  // leading block now classifies under the same rule — disclaimers reported,
  // the header consumed, data intact.
  const parsed = parseCsv(
    "Bank export - confidential\nGenerated 2026-07-01\nDate,Amount,Description\n2026-07-01,12.50,salary\n2026-07-02,-5.00,coffee\n",
    { date: 0, amount: 1, description: 2 },
  );
  assert.deepEqual(
    parsed.lines.map((line) => line.amount),
    ["12.5000", "-5.0000"],
  );
  assert.deepEqual(parsed.skipped, [
    { line: 1, code: "csv_metadata_row", dateCell: "Bank export - confidential" },
    { line: 2, code: "csv_metadata_row", dateCell: "Generated 2026-07-01" },
  ]);
});

test("a transaction-looking row inside a preamble refuses by row number", () => {
  // A set-aside block must never swallow a real transaction: the row that
  // reads as one refuses with its number and the remedy, even mid-block.
  assert.throws(
    () =>
      parseCsv("Bank export - confidential\noops,12.50,salary\n2026-07-01,5.00,coffee\n", {
        date: 0,
        amount: 1,
        description: 2,
      }),
    (error: unknown) =>
      error instanceof BankingError &&
      /CSV row 2 looks like a transaction/.test(error.message) &&
      /remove the row|fix the date/.test(error.message),
  );
});

test("a transaction-looking first row with a bad date refuses by name", () => {
  // A parseable amount plus a description reads as a transaction: dropping
  // the row would lose real money, so the parse refuses with the row number
  // and the remedy instead of skipping it.
  assert.throws(
    () => parseCsv("oops,12.50,salary\n2026-07-01,5.00,coffee\n", { date: 0, amount: 1, description: 2 }),
    (error: unknown) =>
      error instanceof BankingError &&
      /CSV row 1 looks like a transaction/.test(error.message) &&
      /remove the row|fix the date/.test(error.message),
  );
});

test("human statement amounts still accept the unambiguous comma readings", () => {
  // A decimal comma with a one- or two-digit tail ("123,45") is correct in
  // every decimal-comma locale; repeated three-digit groups settle the
  // reading the way a lone comma cannot.
  const parsed = parseCsv(
    'date,amount,description\n2026-07-01,"123,45",salary\n2026-07-02,"1,234,567",refund\n',
    { date: 0, amount: 1, description: 2 },
  );
  assert.deepEqual(parsed.lines.map((line) => line.amount), ["123.4500", "1234567.0000"]);
});

test("statement amounts wider than numeric(19,4) fail closed at parse time", () => {
  // Pasted statement figures used to normalize fine and die only at the
  // numeric(19,4) insert with a storage error. Every format funnels through
  // the same column, so every parser refuses the same way.
  assert.throws(
    () => parseCsv("date,amount,description\n2026-07-01,99999999999999999999,salary\n", { date: 0, amount: 1, description: 2 }),
    (error: unknown) => error instanceof BankingError && /out of range/.test(error.message),
  );
  assert.throws(
    () => parseBai2([baiHeader, "16,165,9999999999999999999999,S,REF,,deposit/"].join("\n")),
    (error: unknown) => error instanceof BankingError && /out of range/.test(error.message),
  );
  // The column maximum itself still parses in both spellings.
  const csv = parseCsv("date,amount,description\n2026-07-01,999999999999999.9999,salary\n", { date: 0, amount: 1, description: 2 });
  assert.equal(csv.lines[0]!.amount, "999999999999999.9999");
  const bai = parseBai2([baiHeader, "16,165,99999999999999999,S,REF,,deposit/"].join("\n"));
  assert.equal(bai.lines[0]!.amount, "999999999999999.9900");
});
