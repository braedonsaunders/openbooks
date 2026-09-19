/**
 * The JP pack's tax-year support, tenant-declared health rate, and refusal
 * ledger: 2026 transcribed, everything else refused by name.
 *
 * 2026 (this pack): the NTA 令和8年分 給与所得の源泉徴収税額表（月額表,
 * 甲欄 0–7人 + 乙欄, ./tables-2026.ts) and the JPS 厚生年金保険料額表
 * （令和8年度版, 32 grades, ./pension-2026.ts), priced by the pure engine
 * (./withholding-2026.ts) and pushed by the adapter
 * (./compute-statutory.ts). Era year: 令和8年 = 2018 + 8 = 2026.
 *
 * Health insurance has no pack table by design (see ./pack.ts): the
 * 協会けんぽ rate is deliberated per prefecture per year (Tokyo 9.85% for
 * 令和8年度, per 全国健康保険協会東京支部
 * 「令和8年度都道府県単位保険料率と健康保険法改正等について」:
 * 「令和7年度保険料率の9.91%から、0.06%引き下げ、9.85%」) and each
 * 健康保険組合 sets its own, so the employer enters the in-force rate in
 * the jp_health_rate slot (scope region) exactly as they enter a SUI
 * experience rate. The engine reads the resolution and refuses an
 * unconfigured prefecture rather than guessing.
 */
import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollTaxYearSupport } from "../tax-years.ts";

/** Edition stamp for JP_TAX_YEARS. */
export const JP_2026_EDITION_LABEL =
  "令和8年分 源泉徴収税額表（月額表）+ 厚生年金保険料額表（令和8年度版）";

/**
 * Named refusals: everything the 2026 engine does not compute, with the
 * reason. The engine quotes these names back.
 */
export const JP_REFUSED_2026: readonly string[] = [
  "乙欄 for pay below 105,000円 is computed (3.063% rule); the 従たる給与申告書 1,610円-per-dependent reduction is refused (no second-employer certificate channel)",
  "扶養親族等の数 above 7 (the table's 7人超 1,610円-per-person subtraction is not transcribed)",
  "社会保険料等控除後の給与等の金額 of 740,000円 or more (the table's 20.42%/23.483%/33.693%/40.84%/45.945% formula rows are not transcribed)",
  "日額表 daily payrolls (the 日額表, 甲/乙/丙, is not transcribed — monthly payroll only)",
  "賞与 bonus withholding (the 賞与に対する源泉徴収税額の算出率の表 is not transcribed; any non-periodic amount refuses)",
  "雇用保険 premiums (料率 untranscribed; the gensen base therefore deducts 厚生年金 + 健康保険 only — stated, not hidden)",
  "介護保険 for 40-to-64-year-olds (no age channel; 介護保険第2号被保険者 refuses unless explicitly declared otherwise)",
  "子ども・子育て拠出金 employer levy 0.36% (employer-only; no slot declared in round one)",
  "住民税 special collection (the municipality assigns the amount; no engine channel — 特別徴収 is collected, never computed)",
  "年末調整 year-end adjustment (no channel; never half-implemented)",
  "定時決定/随時改定 grade mechanics (the 標準報酬月額 arrives as an operator-entered fact from the JPS notice, never derived from current pay)",
  "健康保険組合-specific ceilings above the pension grades (the 協会けんぽ 50-grade ceiling is documented, not priced)",
  "所得税徴収高計算書 remittance builder and 法定調書 (源泉徴収票/給与支払報告書) population",
  "non-resident 20.42% withholding (所得税法第212条: a separate mechanism, not the 月額表)",
];

export const JP_TAX_YEARS: PayrollTaxYearSupport = {
  country: "JP",
  editions: [
    {
      year: 2026,
      label: JP_2026_EDITION_LABEL,
      effectiveFrom: "2026-01-01",
      citation:
        "NTA 令和8年分 給与所得の源泉徴収税額表（月額表, 平成24年3月31日財務省告示"
        + "第115号別表第一（令和7年4月30日財務省告示第122号改正）); JPS 厚生年金保険料額表"
        + "（令和8年度版, 令和2年9月分～); NTA No.2511 税額表の種類と使い方 "
        + "（令和8年4月1日現在法令等）",
      status: "published",
    },
  ],
  // No prefecture publishes its own withholding tables the Québec way: the
  // health premium rides the national computation from the tenant-declared
  // jp_health_rate (see below), identically for all 47.
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/jp/rates.ts",
  scaffold: {
    files: [
      {
        path: "engine/src/payroll/jp/tables-{year}.ts",
        purpose:
          "NTA 源泉徴収税額表（月額表 甲/乙) rows and JPS 厚生年金保険料額表 grades transcribed "
          + "from the year's NTA pamphlet Excel and JPS premium-table Excel, beside the {priorYear} edition",
        template:
          "export const JP_GENSEN_MONTHLY_{year} = [\n"
          + "  // Transcribed from the NTA zeigakuhyo{year} Excel (月額表 sheet), reconciled row by row.\n"
          + "  // Prior edition: JP_GENSEN_MONTHLY_{priorYear}.\n"
          + "];\n",
      },
    ],
    barrels: [],
    steps: [
      "Fetch the year's NTA 源泉徴収税額表 Excel (publication/pamph/gensen/zeigakuhyo{year}/data/01-07.xls) "
      + "and transcribe the 月額表 甲/乙 rows beside the {priorYear} edition.",
      "Transcribe the year's JPS 厚生年金保険料額表 Excel (nenkin.go.jp ryogakuhyo files) — "
      + "grades, 標準報酬月額, and 折半額.",
      "Confirm the 協会けんぽ Tokyo rate for the year from the Tokyo branch notice; "
      + "health rates stay tenant-declared, never pack constants.",
      "Add the edition to JP_TAX_YEARS.editions with the NTA/JPS citations and wire "
      + "computeJpStatutory to the tables.",
    ],
  },
};

/**
 * Tenant-entered statutory rate: the health-insurance rate in force for the
 * prefecture. Deliberated yearly by each 協会けんぽ 都道府県支部 (47 rates;
 * Tokyo 9.85% for 令和8年度) and set independently by each 健康保険組合 —
 * no publication a payroll system can carry supplies them, so the employer
 * enters the in-force rate, exactly as they enter a SUI experience rate.
 * The engine reads the resolution and refuses an unconfigured prefecture
 * rather than guessing.
 */
export const JP_PACK_RATES: PayrollPackRates = {
  country: "JP",
  slots: [
    {
      key: "jp_health_rate",
      label: "健康保険料率 — Health insurance rate in force",
      scope: "region",
      systemKeys: ["health"],
      fields: [
        {
          key: "rate",
          label: "Health insurance rate (%)",
          kind: "percent",
          decimals: 3,
          min: "0",
          max: "100",
          required: true,
          help: "The in-force 健康保険 rate as a percent number (9.85 for 9.85%): the 協会けんぽ "
            + "都道府県支部 rate for the employment prefecture, or the employer's 健康保険組合 rate. "
            + "Employee and employer each pay half (折半).",
        },
      ],
      citation:
        "全国健康保険協会 都道府県支部保険料率 (yearly); 健康保険組合定款 (per-union rate)",
      variesBecause:
        "each of the 47 協会けんぽ branches deliberates its own rate yearly and each 健康保険組合 "
        + "sets its own; no pack constant can carry them",
    },
  ],
};
