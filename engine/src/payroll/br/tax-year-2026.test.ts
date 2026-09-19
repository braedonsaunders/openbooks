/**
 * BR 2026 goldens and sweeps: the pure INSS + IRRF calculators.
 *
 * Every figure below is hand-worked from the transcribed instruments
 * (Portaria 13/2026 Anexo I; the monthly table; Lei 15.270/2025 art. 3º-A)
 * with per-slice/per-amount truncation to cents. The official Receita
 * examples (Maria R$ 5.000 → zero; R$ 6.000 simplified → bruto 574,29,
 * redutor 179,75, final 394,54) are reproduced exactly.
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateBrInss2026 } from "./inss-2026.ts";
import { calculateBrIrrf2026 } from "./irrf-2026.ts";

const inss = (salario: string): string =>
  calculateBrInss2026({ salarioContribuicao: salario }).contribuicao;

test("INSS sweeps every bracket edge and the teto", () => {
  // Hand-worked, slice by slice, truncated:
  // 1621,00 × 7,5% = 121,575 → 121,57.
  assert.equal(inss("1621.00"), "121.57");
  // One centavo into the 9% slice prices nothing extra (0,01 × 9% truncates).
  assert.equal(inss("1621.01"), "121.57");
  // 1281,84 × 9% = 115,3656 → 115,36; total 236,93.
  assert.equal(inss("2902.84"), "236.93");
  assert.equal(inss("2902.85"), "236.93");
  // 1451,43 × 12% = 174,1716 → 174,17; total 411,10.
  assert.equal(inss("4354.27"), "411.10");
  assert.equal(inss("4354.28"), "411.10");
  // 4121,27 × 14% = 576,9778 → 576,97; teto total 988,07.
  assert.equal(inss("8475.55"), "988.07");
  // Above the teto prices nothing more.
  assert.equal(inss("8475.56"), "988.07");
  assert.equal(inss("20000.00"), "988.07");
  assert.equal(calculateBrInss2026({ salarioContribuicao: "20000.00" }).baseTributavel, "8475.55");
});

test("INSS is sliced progressively, never flat-rated at the top rate", () => {
  // The classic error: 3.000,00 × 12% = 360,00. The sliced truth:
  // 121,57 + 115,36 + (97,16 × 12% = 11,6592 → 11,65) = 248,58.
  // "248.58" also pins truncation: exact-then-round gives 248,60.
  const result = calculateBrInss2026({ salarioContribuicao: "3000.00" });
  assert.equal(result.contribuicao, "248.58");
  assert.deepEqual(result.fatias, ["121.57", "115.36", "11.65"]);
  assert.notEqual(result.contribuicao, "360.00");
});

test("INSS is monotone and flat past the teto", () => {
  const centsOf = (amount: string): bigint => {
    const [whole = "0", frac = "00"] = amount.split(".");
    return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0").slice(0, 2));
  };
  const salaries = ["0.00", "1000.00", "1621.00", "2500.00", "4354.27", "6000.00", "8475.55", "8475.56", "30000.00"];
  const amounts = salaries.map(inss);
  for (let i = 1; i < amounts.length; i++) {
    assert.ok(centsOf(amounts[i]!) >= centsOf(amounts[i - 1]!), `${salaries[i]} prices below ${salaries[i - 1]}`);
  }
  assert.ok(amounts[5]! > amounts[4]!, "still rising below the teto");
  assert.equal(amounts[7], amounts[6], "flat past the teto");
});

test("IRRF sweeps every monthly band edge", () => {
  // Legal deductions win throughout (inss 1000 > 607,20), so the base is
  // exactly R − 1000 and each assertion below pins one band.
  const bruto = (r: string): string =>
    calculateBrIrrf2026({ rendimentos: r, inss: "1000.00", dependentes: 0, pensaoMensal: "0.00" }).impostoBruto;
  // Base 2826,65: 423,9975 → 423,99 − 394,16 = 29,83.
  assert.equal(bruto("3826.65"), "29.83");
  // Base 3751,05: 843,98625 → 843,98 − 675,49 = 168,49.
  assert.equal(bruto("4751.05"), "168.49");
  // Base 3751,06 prices the same centavo — no step at the joint.
  assert.equal(bruto("4751.06"), "168.49");
  // Base 4664,68 falls in the 22,5% band ("até 4.664,68" is inclusive):
  // 1049,553 → 1049,55 − 675,49 = 374,06. Base 4664,69 enters 27,5%:
  // 1282,78975 → 1282,78 − 908,73 = 374,05 — one centavo BELOW its
  // neighbour, the visible trace of the published 908,73 sitting one centavo
  // above the truncated derivation. Transcribed, not smoothed.
  assert.equal(bruto("5664.68"), "374.06");
  assert.equal(bruto("5664.69"), "374.05");
});

test("IRRF: official Maria golden — R$ 5.000 simplified zeroes exactly", () => {
  // Base 4392,80 × 22,5% = 988,38 − 675,49 = 312,89; reduction min(312,89,
  // 312,89); final zero. (Receita's official example.)
  const result = calculateBrIrrf2026({ rendimentos: "5000.00", inss: "0.00", dependentes: 0, pensaoMensal: "0.00" });
  assert.equal(result.deducaoVia, "simplificado");
  assert.equal(result.deducaoAplicada, "607.20");
  assert.equal(result.baseCalculo, "4392.80");
  assert.equal(result.impostoBruto, "312.89");
  assert.equal(result.reducao, "312.89");
  assert.equal(result.irrf, "0.00");
});

test("IRRF: official R$ 6.000 golden — bruto 574,29, redutor 179,75, final 394,54", () => {
  // Base 5392,80 × 27,5% = 1483,02 − 908,73 = 574,29;
  // redutor 978,62 − 0,133145 × 6000 = 978,62 − 798,87 = 179,75.
  const result = calculateBrIrrf2026({ rendimentos: "6000.00", inss: "0.00", dependentes: 0, pensaoMensal: "0.00" });
  assert.equal(result.baseCalculo, "5392.80");
  assert.equal(result.impostoBruto, "574.29");
  assert.equal(result.reducao, "179.75");
  assert.equal(result.irrf, "394.54");
});

test("IRRF: R$ 4.800 simplified — bruto 267,89 fully absorbed, floored at zero", () => {
  // Base 4192,80 × 22,5% = 943,38 − 675,49 = 267,89; min(267,89, 312,89)
  // subtracts the whole tax; the −45,00 never goes negative.
  const result = calculateBrIrrf2026({ rendimentos: "4800.00", inss: "0.00", dependentes: 0, pensaoMensal: "0.00" });
  assert.equal(result.impostoBruto, "267.89");
  assert.equal(result.reducao, "267.89");
  assert.equal(result.irrf, "0.00");
});

test("IRRF: legal deductions win when they beat the simplified", () => {
  // INSS 641,50 alone beats 607,20: base 5358,50 × 27,5% = 1473,5875 →
  // 1473,58 − 908,73 = 564,85; redutor on gross 6000 = 179,75.
  const result = calculateBrIrrf2026({ rendimentos: "6000.00", inss: "641.50", dependentes: 0, pensaoMensal: "0.00" });
  assert.equal(result.deducaoVia, "legal");
  assert.equal(result.deducaoAplicada, "641.50");
  assert.equal(result.baseCalculo, "5358.50");
  assert.equal(result.impostoBruto, "564.85");
  assert.equal(result.reducao, "179.75");
  assert.equal(result.irrf, "385.10");
});

test("IRRF: dependents and pensão join the legal arm", () => {
  // 500 + 189,59 + 200 = 889,59 > 607,20: base 5110,41 × 27,5% =
  // 1405,36275 → 1405,36 − 908,73 = 496,63; minus 179,75 = 316,88.
  const result = calculateBrIrrf2026({ rendimentos: "6000.00", inss: "500.00", dependentes: 1, pensaoMensal: "200.00" });
  assert.equal(result.deducaoVia, "legal");
  assert.equal(result.deducaoAplicada, "889.59");
  assert.equal(result.baseCalculo, "5110.41");
  assert.equal(result.impostoBruto, "496.63");
  assert.equal(result.irrf, "316.88");
});

test("IRRF: transition joints are continuous and capped", () => {
  const irrf = (r: string): string =>
    calculateBrIrrf2026({ rendimentos: r, inss: "0.00", dependentes: 0, pensaoMensal: "0.00" }).irrf;
  // Just above 5000 the formula gives 312,90 but the computed tax caps it:
  // still zero, continuous with Maria.
  assert.equal(irrf("5000.01"), "0.00");
  // At exactly 7350 the formula leaves 0,01 (978,62 − 978,61): 945,54 −
  // 0,01 = 945,53; one centavo later the reduction is gone: 945,54.
  assert.equal(irrf("7350.00"), "945.53");
  assert.equal(irrf("7350.01"), "945.54");
  // High earners: base 7392,80 → 2033,02 − 908,73 = 1124,29, no reduction.
  assert.equal(irrf("8000.00"), "1124.29");
});

test("IRRF is monotone in gross pay and never negative", () => {
  const centsOf = (amount: string): bigint => {
    const [whole = "0", frac = "00"] = amount.split(".");
    return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0").slice(0, 2));
  };
  const pays = ["0.00", "1000.00", "3000.00", "5000.00", "5500.00", "6000.00", "7350.00", "20000.00"];
  const amounts = pays.map((r) =>
    calculateBrIrrf2026({ rendimentos: r, inss: "0.00", dependentes: 0, pensaoMensal: "0.00" }).irrf);
  for (let i = 1; i < amounts.length; i++) {
    assert.ok(centsOf(amounts[i]!) >= centsOf(amounts[i - 1]!), `${pays[i]} withholds below ${pays[i - 1]}`);
  }
  for (const amount of amounts) assert.ok(centsOf(amount) >= 0n, "negative withholding");
});

test("IRRF refuses malformed deduction inputs", () => {
  assert.throws(() => calculateBrIrrf2026({ rendimentos: "5000.00", inss: "0.00", dependentes: -1, pensaoMensal: "0.00" }));
  assert.throws(() => calculateBrIrrf2026({ rendimentos: "5000.00", inss: "0.00", dependentes: 1.5, pensaoMensal: "0.00" }));
  assert.throws(() => calculateBrIrrf2026({ rendimentos: "abc", inss: "0.00", dependentes: 0, pensaoMensal: "0.00" }));
});
