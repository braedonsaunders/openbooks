/**
 * The JP pack's year-end filing declaration: the three statutory year-end
 * faces of payroll withholding, DECLARED but refusing population by name.
 *
 * - 給与所得の源泉徴収票: the employee-facing withholding record. The
 *   employer issues it to each employee and files it with the tax office
 *   (所得税法第225条 — 法定調書), by January 31 of the following year.
 * - 給与支払報告書: the same figures to the employee's municipality of
 *   residence (as of January 1), by January 31 (地方税法第317条の6) — the
 *   basis of the resident-tax 特別徴収 the municipality then assigns. A
 *   different recipient and deadline, not a second copy of the slip.
 * - 給与所得の源泉徴収票等の法定調書合計表: the employer summary cover
 *   sheet accompanying the 法定調書 to the tax office, by the same
 *   January 31.
 *
 * THE BOX SET (NTA 給与所得の源泉徴収票 様式 — each box cited to the form):
 * payment core — 支払金額, 給与所得控除後の金額, 所得控除の額の合計額,
 * 源泉徴収税額; deduction detail — 社会保険料等の金額, 生命保険料の控除額,
 * 地震保険料の控除額, 小規模企業共済等掛金の控除額, 配偶者(特別)控除の額,
 * (源泉)控除対象配偶者の有無等, 控除対象扶養親族の数 and 障害者の数,
 * 16歳未満の扶養親族, 住宅借入金等特別控除の額/可能額/居住開始年月日,
 * 摘要; employment facts — 中途就・退職 (就職/退職年月日), 未成年者/
 * 外国人/死亡退職/災害者区分, 乙欄, 本人障害・寡婦・ひとり親・勤労学生;
 * parties — 受給者 (個人番号・住所・氏名), 支払者 (住所・名称,
 * 個人番号/法人番号).
 *
 * WHY POPULATION REFUSES. The 源泉徴収税額 box asks for the finalized
 * annual liability — the 年調年税額 recomputed at 年末調整 against the
 * employee's declared deductions, with the difference settled in the final
 * pay of the year (NTA 年末調整のしかた, 所得税法第190条) — NOT the sum of
 * the monthly withholdings. This engine performs monthly 源泉徴収 only
 * (see JP_REFUSED_2026 in ./rates.ts: 年末調整 has no channel, and none of
 * the year-end declaration facts exist either — no 基礎控除申告書, no
 * 保険料控除申告書, no 配偶者控除等申告書, no 住宅借入金等特別控除申告書;
 * the jp_fuyo certificate carries only the 月額表 dependent count). The raw
 * sums ARE in the committed stubs (gross paid, KOSEI/KENKO shares, monthly
 * gensen), but printing the monthly sum in the adjusted-tax box would file a
 * wrong statutory figure that looks entirely reasonable — so every
 * population refuses before any read, and slips arrive with the builders,
 * never ahead of them (the IT-pack pattern). For 2024 the refusal is
 * doubled: the 定額減税 fixed-amount credit settles at year-end with
 * carry-forward the engine has no channel for.
 *
 * The two companion filings are blocked by the same root cause: the
 * 給与支払報告書 carries the same per-employee adjusted figures to a
 * different recipient, and the 法定調書合計表 aggregates the adjusted slips
 * it covers.
 */
import { PayrollPackError } from "../payroll-error.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollPackFilings,
} from "../filing-registry.ts";

function refusePopulation(filing: string, box: string, year: number): Promise<PayrollFilingData> {
  const teigaku = year === 2024
    ? " For 2024 the 定額減税 fixed-amount credit additionally settles at year-end with carry-forward "
    + "the engine has no channel for."
    : "";
  return Promise.reject(
    new PayrollPackError(
      `the JP payroll pack declares the ${filing} filing but cannot populate it for tax year ${year}: `
      + "the engine performs monthly 源泉徴収 only and does not perform 年末調整 "
      + "(see JP_REFUSED_2026 in engine/src/payroll/jp/rates.ts), so no 年調年税額 exists to report "
      + `in the ${box} box — printing the sum of monthly withholdings there would file a wrong `
      + "statutory figure. Perform 年末調整 following the NTA's 年末調整のしかた "
      + "(所得税法第190条) and prepare the filing outside this product."
      + teigaku,
    ),
  );
}

/** No rows exist while population refuses, so no row id parses (IT pattern). */
function refuseRowId(): PayrollFilingRowScope | null {
  return null;
}

export function jpPackFilings(): PayrollPackFilings {
  return {
    country: "JP",
    programTypes: [
      {
        key: "jp_shaho_jigyosho",
        label: "社会保険適用事業所 (JPS-registered establishment)",
      },
    ],
    yearEnd: [
      {
        key: "gensenchoshu",
        label: "給与所得の源泉徴収票",
        cadence: "annual",
        description:
          "給与所得の源泉徴収票 — the employee's annual withholding record, issued to the employee "
          + "and filed with the tax office as 法定調書 (所得税法第225条) by January 31 of the following year. "
          + "Its 源泉徴収税額 box carries the year-end-adjusted tax (年調年税額), never the monthly sum.",
        emptyText: "No 源泉徴収票 can be produced: 年末調整 is not performed.",
        population: (_orgId, taxYear) => refusePopulation("給与所得の源泉徴収票", "源泉徴収税額", taxYear),
        parseRowId: () => refuseRowId(),
        downloadRefusal:
          "the JP pack produces no e-Tax / 光ディスク等 法定調書 file — the slip figures are not "
          + "computed; transmit the 源泉徴収票 through e-Tax or submit paper/光ディスク to the tax office",
        amendment: {
          supported: false,
          refusal:
            "a wrong 源泉徴収票 is corrected by reissuing a corrected slip to the employee and "
            + "resubmitting the 法定調書 to the tax office — reissue is not implemented by the JP "
            + "payroll pack; prepare the corrected slip outside this product (NTA 年末調整のしかた / "
            + "法定調書の作成と提出の手引) and resubmit",
        },
      },
      {
        key: "kyuyo_shiharai_hokokusho",
        label: "給与支払報告書",
        cadence: "annual",
        description:
          "給与支払報告書 — the same per-employee figures reported to the employee's municipality of "
          + "residence (as of January 1) by January 31 (地方税法第317条の6), the basis of the resident-tax "
          + "特別徴収 the municipality assigns. Same figures, different recipient and deadline.",
        emptyText: "No 給与支払報告書 can be produced: 年末調整 is not performed.",
        population: (_orgId, taxYear) => refusePopulation("給与支払報告書", "源泉徴収税額", taxYear),
        parseRowId: () => refuseRowId(),
        downloadRefusal:
          "the JP pack produces no eLTAX 給与支払報告書 file — the report figures are not computed; "
          + "submit to the municipality through eLTAX (地方税ポータルシステム) or on paper",
        amendment: {
          supported: false,
          refusal:
            "a wrong 給与支払報告書 is corrected by resubmitting a corrected report to the municipality "
            + "— resubmission is not implemented by the JP payroll pack; prepare the corrected report "
            + "outside this product and resubmit through eLTAX or on paper",
        },
      },
      {
        key: "hotei_chosho_gokeihyo",
        label: "給与所得の源泉徴収票等の法定調書合計表",
        cadence: "annual",
        description:
          "給与所得の源泉徴収票等の法定調書合計表 — the employer summary cover sheet accompanying the "
          + "法定調書 to the tax office by January 31. It aggregates the adjusted slips it covers.",
        emptyText: "No 法定調書合計表 can be produced: 年末調整 is not performed.",
        population: (_orgId, taxYear) => refusePopulation("給与所得の源泉徴収票等の法定調書合計表", "源泉徴収税額", taxYear),
        parseRowId: () => refuseRowId(),
        downloadRefusal:
          "the JP pack produces no e-Tax / 光ディスク等 法定調書合計表 file — the summary aggregates "
          + "slips that are not computed; transmit through e-Tax or submit paper/光ディスク to the tax office",
        amendment: {
          supported: false,
          refusal:
            "a wrong 法定調書合計表 is corrected by resubmitting a corrected summary with the corrected "
            + "法定調書 to the tax office — resubmission is not implemented by the JP payroll pack; "
            + "prepare the corrected summary outside this product and resubmit",
        },
      },
    ],
  };
}
