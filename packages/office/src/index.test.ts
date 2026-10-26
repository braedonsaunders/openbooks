import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  createStreamingXlsxExport,
  readSheet,
  reportResultToXlsx,
  SheetReadError,
  statementSheetToXlsx,
  xlsxMoneyCell,
  xlsxQuantityCell,
  XlsxMoneyRefusal,
} from "./index";

test("statement XLSX preserves the numeric(19,4) ledger maximum exactly", async () => {
  const ledgerMaximum = "999999999999999.9999";
  const buffer = await statementSheetToXlsx(
    {
      company: "Example Company",
      title: "Balance Sheet",
      periodPhrase: "Year ended 2026-12-31",
      accountLabel: "Account",
      columns: [{ label: "Balance", kind: "amount" }],
      rows: [{ kind: "account", label: "Ledger maximum", values: [ledgerMaximum] }],
    },
    { generatedAt: new Date("2026-08-28T12:00:00.000Z") },
  );

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const worksheet = workbook.worksheets[0];
  assert.ok(worksheet);

  // The data row follows the title, period, and header rows (row 6, column B).
  assert.equal(worksheet.getCell(6, 2).value, ledgerMaximum);
});

test("readSheet concatenates rich-text runs instead of importing them empty", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Import");
  ws.getCell(1, 1).value = "Name";
  ws.getCell(1, 2).value = "Note";
  ws.getCell(2, 1).value = "Widget";
  ws.getCell(2, 2).value = { richText: [{ text: "Hello " }, { text: "World" }] };
  const buffer = await wb.xlsx.writeBuffer();
  const { headers, rows } = await readSheet(
    Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer),
  );
  assert.deepEqual(headers, ["Name", "Note"]);
  assert.deepEqual(rows, [["Widget", "Hello World"]]);
});

test("readSheet refuses a spreadsheet error value naming its cell", async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Import");
  ws.getCell(1, 1).value = "Name";
  ws.getCell(1, 2).value = "Qty";
  ws.getCell(2, 1).value = "Widget";
  ws.getCell(2, 2).value = { error: "#DIV/0!" };
  const buffer = await wb.xlsx.writeBuffer();
  await assert.rejects(
    () => readSheet(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer)),
    (error: unknown) => {
      assert.ok(error instanceof SheetReadError);
      assert.match((error as Error).message, /B2/);
      assert.match((error as Error).message, /#DIV\/0!/);
      return true;
    },
  );
});

test("report XLSX writes money as exact numbers in its currency format but leaves counts and quantities alone", async () => {
  const buffer = await reportResultToXlsx(
    {
      groups: [
        {
          kind: "results" as const,
          title: "Recall",
          columns: ["Lots", "Qty", "Amount"],
          rows: [[3, 1.5, "19.9900"]],
          money: [false, false, true],
        },
      ],
      summary: [],
      rowCount: 1,
    },
    {
      reportName: "Recall",
      generatedAt: new Date("2026-01-01T00:00:00Z"),
      money: { currency: "USD", minorUnits: { USD: 2 } },
    },
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = workbook.worksheets[0]!;
  // Data row 5: the count stays a bare number with no forced format (Excel
  // shows General — never 3.00), the quantity keeps its natural precision,
  // and the money column is the exact amount in its currency's format.
  assert.equal(ws.getCell(5, 1).value, 3);
  assert.equal(ws.getCell(5, 1).numFmt, undefined);
  assert.equal(ws.getCell(5, 2).value, 1.5);
  assert.equal(ws.getCell(5, 2).numFmt, undefined);
  assert.equal(ws.getCell(5, 3).value, 19.99);
  assert.equal(ws.getCell(5, 3).numFmt, "[$USD] #,##0.00;([$USD] #,##0.00)");
});

test("money cells follow each currency’s minor units, a row’s own currency, and refuse what a spreadsheet cannot hold", async () => {
  const money = { currency: "USD", minorUnits: { USD: 2, JPY: 0, BHD: 3 } };
  const group = {
    kind: "results" as const,
    title: "Ledger",
    columns: ["Currency", "Amount (txn)", "Amount", "Fee", "Memo amount"],
    rows: [
      ["JPY", "125000.0000", "831.4500", "1.250", "7.5000"],
      ["BHD", "12.3450", "32.7300", "—", ""],
    ] as (string | number | null)[][],
    money: [false, true, true, true, true],
    moneyCurrencies: [null, { column: 0 }, null, "BHD", "unstated"] as (
      { column: number } | string | null
    )[],
  };
  const opts = { reportName: "Ledger", generatedAt: new Date("2026-10-19T00:00:00Z"), money };
  const buffered = await reportResultToXlsx(
    { groups: [structuredClone(group)], summary: [], rowCount: 2 },
    opts,
  );
  const writer = createStreamingXlsxExport({
    ...opts,
    groups: [
      {
        title: group.title,
        columns: group.columns,
        widths: group.columns.map(() => 12),
        money: group.money,
        moneyCurrencies: group.moneyCurrencies,
      },
    ],
  });
  writer.appendRows(0, group.rows);
  const streamed = await writer.finish();
  for (const [name, buffer] of [
    ["buffered", buffered],
    ["streamed", streamed],
  ] as const) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = workbook.worksheets[0]!;
    assert.equal(ws.getCell(5, 2).value, 125000, `${name} yen amount`);
    assert.equal(
      ws.getCell(5, 2).numFmt,
      "[$JPY] #,##0;([$JPY] #,##0)",
      `${name}: yen has no minor units`,
    );
    assert.equal(ws.getCell(6, 2).value, 12.345, `${name} dinar amount`);
    assert.equal(
      ws.getCell(6, 2).numFmt,
      "[$BHD] #,##0.000;([$BHD] #,##0.000)",
      `${name}: the row's own currency`,
    );
    assert.equal(
      ws.getCell(5, 3).numFmt,
      "[$USD] #,##0.00;([$USD] #,##0.00)",
      `${name}: the report's currency`,
    );
    assert.equal(ws.getCell(5, 4).value, 1.25, `${name} fixed-currency column`);
    assert.equal(ws.getCell(5, 4).numFmt, "[$BHD] #,##0.000;([$BHD] #,##0.000)");
    assert.equal(ws.getCell(5, 5).value, 7.5, `${name} unstated currency`);
    assert.equal(
      ws.getCell(5, 5).numFmt,
      "#,##0.0;(#,##0.0)",
      `${name}: no currency label without a known currency`,
    );
    assert.equal(ws.getCell(6, 4).value, "—", `${name}: text in a money column stays text`);
  }

  const inexact = { ...group, rows: [["USD", "9007199254740.9938", "0", "0", "0"]] };
  for (const write of [
    () =>
      reportResultToXlsx({ groups: [structuredClone(inexact)], summary: [], rowCount: 1 }, opts),
    async () => {
      const w = createStreamingXlsxExport({
        ...opts,
        groups: [
          {
            title: "Ledger",
            columns: inexact.columns,
            widths: [12, 12, 12, 12, 12],
            money: inexact.money,
            moneyCurrencies: inexact.moneyCurrencies,
          },
        ],
      });
      w.appendRows(0, inexact.rows);
      return w.finish();
    },
  ]) {
    await assert.rejects(
      write,
      (error: unknown) =>
        error instanceof XlsxMoneyRefusal &&
        error.code === "xlsx_money_inexact" &&
        error.status === 422,
    );
  }
  await assert.rejects(
    reportResultToXlsx(
      {
        groups: [{ ...structuredClone(group), rows: [["XTS", "1.00", "1.00", "1.00", "1.00"]] }],
        summary: [],
        rowCount: 1,
      },
      opts,
    ),
    (error: unknown) =>
      error instanceof XlsxMoneyRefusal &&
      error.code === "xlsx_currency_unknown" &&
      /XTS/.test(error.message),
    "a currency the registry does not know refuses rather than guessing its precision",
  );
});

test("a money cell converts only when the number reads back as the same amount", () => {
  const usd = { code: "USD", minorUnits: 2 };
  assert.deepEqual(xlsxMoneyCell("0.1000", usd), {
    value: 0.1,
    numFmt: "[$USD] #,##0.00;([$USD] #,##0.00)",
  });
  assert.deepEqual(xlsxMoneyCell("-0.0000", usd)?.value, 0);
  assert.deepEqual(
    xlsxMoneyCell("999999999999.999", usd)?.value,
    999999999999.999,
    "fifteen significant digits fit exactly",
  );
  assert.throws(() => xlsxMoneyCell("9999999999999.999", usd), XlsxMoneyRefusal, "sixteen do not");
  assert.equal(xlsxMoneyCell("n/a", usd), null);
  assert.equal(xlsxMoneyCell(null, usd), null);
});

test("report XLSX neutralises formula-looking strings with the CSV quote prefix", async () => {
  // A memo like =HYPERLINK(...) must reach the sheet as inert text on both
  // writers — the same leading-quote neutralization the CSV surface applies —
  // while genuinely numeric text stays untouched. Literals, not the guard
  // itself, are the oracle: without the fix the raw memo lands in the cell.
  const risky = ['=HYPERLINK("https://evil.example","x")', "+1+1", "-2+3", "@SUM(A1:A2)", "\t=1+1"];
  const result = {
    groups: [
      {
        kind: "results" as const,
        title: "=RISKY TITLE",
        columns: ["=Memo", "Amount"],
        rows: [
          ...risky.map((memo) => [memo, 1] as (string | number)[]),
          ["-12.5", 2],
          ["plain", 3],
        ],
      },
    ],
    summary: [],
    rowCount: risky.length + 2,
  };
  const opts = {
    reportName: "=RISKY REPORT",
    generatedAt: new Date("2026-01-01T00:00:00Z"),
    money: null,
  };

  const buffered = await reportResultToXlsx(structuredClone(result), opts);
  const writer = createStreamingXlsxExport({
    reportName: opts.reportName,
    generatedAt: opts.generatedAt,
    money: null,
    groups: [{ title: "=RISKY TITLE", columns: ["=Memo", "Amount"], widths: [12, 12] }],
  });
  writer.appendRows(0, result.groups[0]!.rows as (string | number | null | undefined)[][]);
  const streamed = await writer.finish();

  for (const [name, buffer] of [
    ["buffered", buffered],
    ["streamed", streamed],
  ] as const) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = workbook.worksheets[0]!;
    assert.equal(ws.getCell(1, 1).value, "'=RISKY REPORT", `${name} title`);
    assert.equal(ws.getCell(4, 1).value, "'=Memo", `${name} header`);
    risky.forEach((memo, i) => {
      assert.equal(ws.getCell(5 + i, 1).value, `'${memo}`, `${name} row ${i}`);
    });
    assert.equal(ws.getCell(5 + risky.length, 1).value, "-12.5", `${name} numeric text untouched`);
    assert.equal(ws.getCell(6 + risky.length, 1).value, "plain", `${name} plain text untouched`);
  }
});

test("statement XLSX keeps safely representable decimal strings numeric", async () => {
  const buffer = await statementSheetToXlsx({
    company: "Example Company",
    title: "Balance Sheet",
    periodPhrase: "Year ended 2026-12-31",
    accountLabel: "Account",
    columns: [{ label: "Balance", kind: "amount" }],
    rows: [{ kind: "account", label: "Cash", values: ["1234.5000"] }],
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const worksheet = workbook.worksheets[0];
  assert.ok(worksheet);
  assert.equal(worksheet.getCell(6, 2).value, 1234.5);
});

test("statement XLSX keeps adjacent large 4dp amounts distinct instead of collapsing", async () => {
  const buffer = await statementSheetToXlsx({
    company: "Example Company",
    title: "Balance Sheet",
    periodPhrase: "Year ended 2026-12-31",
    accountLabel: "Account",
    columns: [{ label: "Balance", kind: "amount" }],
    rows: [
      { kind: "account", label: "First", values: ["600000000000.0002"] },
      { kind: "account", label: "Second", values: ["600000000000.0003"] },
    ],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const worksheet = workbook.worksheets[0];
  assert.ok(worksheet);
  assert.equal(worksheet.getCell(6, 2).value, 600000000000.0002);
  assert.equal(worksheet.getCell(7, 2).value, "600000000000.0003");
});

test("report XLSX stores typed quantities as numeric cells in both writers, and keeps text it cannot hold exactly", async () => {
  const group = {
    kind: "results" as const,
    title: "Cap table",
    columns: ["Holder", "Shares", "Fully diluted %", "Price", "Amount", "Note"],
    rows: [
      ["Avery Quinn", "4500000", "42.4528", "0.0625", "125.0000", "12"],
      ["Large holder", "9007199254740993", "n/a", "-3.50", "1.00", "-12.5"],
    ] as (string | number | null)[][],
    money: [false, false, false, false, true, false],
    numberFormats: [null, "number", "percent", "number", null, null] as (
      "number" | "percent" | null
    )[],
  };
  const opts = {
    reportName: "Cap table",
    generatedAt: new Date("2026-10-19T00:00:00Z"),
    money: { currency: "USD", minorUnits: { USD: 2 } },
  };
  const buffered = await reportResultToXlsx(
    { groups: [structuredClone(group)], summary: [], rowCount: 2 },
    opts,
  );
  const writer = createStreamingXlsxExport({
    ...opts,
    groups: [
      {
        title: group.title,
        columns: group.columns,
        widths: group.columns.map(() => 12),
        money: group.money,
        numberFormats: group.numberFormats,
      },
    ],
  });
  writer.appendRows(0, group.rows);
  const streamed = await writer.finish();

  for (const [name, buffer] of [
    ["buffered", buffered],
    ["streamed", streamed],
  ] as const) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = workbook.worksheets[0]!;
    assert.equal(ws.getCell(5, 2).value, 4500000, `${name} share count`);
    assert.equal(ws.getCell(5, 2).numFmt, "#,##0", `${name} share format`);
    assert.equal(ws.getCell(5, 3).value, 42.4528, `${name} percent`);
    assert.equal(ws.getCell(5, 3).numFmt, '#,##0.0000"%"', `${name} percent format`);
    assert.equal(ws.getCell(5, 4).value, 0.0625, `${name} price`);
    assert.equal(ws.getCell(5, 4).numFmt, "#,##0.0000", `${name} price format`);
    assert.equal(ws.getCell(6, 4).value, -3.5, `${name} negative quantity`);
    assert.equal(ws.getCell(6, 4).numFmt, "#,##0.00", `${name} negative format`);
    // Beyond Excel's 15 significant digits a count stays exact text, and so
    // does text in a quantity column.
    assert.equal(ws.getCell(6, 2).value, "9007199254740993", `${name} oversized count`);
    assert.equal(ws.getCell(6, 3).value, "n/a", `${name} quantity-column text`);
    // Money is the exact amount in its currency format; untyped columns keep their text.
    assert.equal(ws.getCell(5, 5).value, 125, `${name} money`);
    assert.equal(
      ws.getCell(5, 5).numFmt,
      "[$USD] #,##0.00;([$USD] #,##0.00)",
      `${name} money format`,
    );
    assert.equal(ws.getCell(6, 6).value, "-12.5", `${name} untyped`);
  }
});

test("a per-share column reads under the per-share rule while its cell keeps the exact value", () => {
  assert.deepEqual(xlsxQuantityCell("1.8814382581", "per_share"), {
    value: 1.8814382581,
    numFmt: "#,##0.0000",
  });
  assert.deepEqual(xlsxQuantityCell("0.0500000000", "per_share"), {
    value: 0.05,
    numFmt: "#,##0.0000",
  });
  assert.deepEqual(
    xlsxQuantityCell("0.0000100000", "per_share"),
    { value: 0.00001, numFmt: "#,##0.00000" },
    "a par value four places would hide keeps the places it needs",
  );
  assert.deepEqual(
    xlsxQuantityCell("2.8446389082", "number"),
    { value: 2.8446389082, numFmt: "#,##0.0000000000" },
    "other quantities keep their own places",
  );
});
