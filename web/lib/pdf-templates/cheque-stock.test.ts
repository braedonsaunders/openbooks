import assert from "node:assert/strict";
import test from "node:test";
import { compileTemplateHtml } from "@openbooks/pdf";
import { PDF_RECORD_TYPE_BY_KEY } from "./catalog";
import { starterTemplate } from "./starters";
import { applyChequeStock, chequeStockFromSource } from "./cheque-stock";

test("cheque stock changes preserve all financial merge content and round-trip audited calibration markers", () => {
  const source = starterTemplate(PDF_RECORD_TYPE_BY_KEY.payroll_cheque!).sourceHtml;
  for (const stock of ["top", "middle", "bottom"] as const) {
    const positioned = applyChequeStock(source, stock, -1.2, 0.5);
    const compiled = compileTemplateHtml(positioned);
    assert.deepEqual(chequeStockFromSource(compiled.sanitizedSource), {
      stock,
      xMm: -1.2,
      yMm: 0.5,
    });
    for (const token of [
      "employee_name",
      "amount",
      "amount_in_words",
      "cheque_number",
      "net_pay",
      "non_cash_earnings",
    ])
      assert.ok(compiled.compiledHtml.includes(`{{${token}}}`));
    assert.match(compiled.compiledHtml, /data-cheque-region="true"/);
    assert.match(compiled.compiledHtml, /width:190.9mm/);
  }
  assert.throws(() => applyChequeStock(source, "top", 6.01, 0), /within 6 mm/);
  assert.throws(() => applyChequeStock(source, "bottom", 0, Number.NaN), /within 6 mm/);
  assert.throws(
    () => applyChequeStock("<div>Custom design</div>", "middle"),
    /Start from a cheque stock preset/,
  );
});

test("cheque bank controls survive native HTML compilation without embedding bank account data", async () => {
  const { applyChequeBankDesign, chequeBankDesign, chequeMicrEncoding } =
    await import("./cheque-stock");
  const source = starterTemplate(PDF_RECORD_TYPE_BY_KEY.payroll_cheque!).sourceHtml;
  const profile = "00000000-0000-4000-8000-000000000001";
  const configured = applyChequeBankDesign(source, profile, true);
  const compiled = compileTemplateHtml(configured);
  assert.deepEqual(chequeBankDesign(compiled.compiledHtml), {
    profileId: profile,
    printMicr: true,
  });
  assert.ok(compiled.compiledHtml.includes("{{micr_transit}}"));
  assert.throws(() => applyChequeBankDesign(source, null, true), /Select a cheque bank profile/);
  assert.throws(() => applyChequeBankDesign(source, "invalid", false), /valid cheque bank profile/);
  assert.equal(
    chequeMicrEncoding(
      compileTemplateHtml(applyChequeBankDesign(source, profile, true, "abcd")).compiledHtml,
    ),
    "abcd",
  );
  assert.equal(chequeMicrEncoding(compiled.compiledHtml), "unicode");
  assert.throws(
    () => applyChequeBankDesign(source, `${profile}" data-cheque-micr="printed`, false),
    /valid cheque bank profile/,
  );
});
