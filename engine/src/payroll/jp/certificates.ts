/**
 * The JP pack's employee-filed withholding input: the 扶養控除等申告書.
 *
 * 「給与所得者の扶養控除等申告書」 is the declaration an employee files with
 * the payer so the payer can apply the 甲欄 (NTA No.2511: 「『給与所得者の
 * 扶養控除等申告書』を提出している人に支払う給与については『甲欄』を、
 * その他の人に支払う給与については『乙欄』を使って税額を求めます」).
 * Without it the payer applies the 乙欄 — so the certificate's PRESENCE is
 * the 甲/乙 answer, and its fields are the 扶養親族等の数 the 甲欄 reads:
 * No.2511 defines it as 「源泉控除対象配偶者と源泉控除対象親族との合計数」,
 * plus one per applicable person-attribute (障害者, 寡婦, ひとり親,
 * 勤労学生) and one per disabled family member (障害者又は同居特別障害者).
 *
 * What is NOT here: the 従たる給与についての扶養控除等申告書 (the second
 * employer's declaration, whose 1,610円-per-dependent 乙欄 reduction has no
 * channel — refused by name), and anything about 年末調整 (refused: no
 * channel). The 16歳未満扶養親族 detail lives inside the count the operator
 * copies off the filed form; the engine trusts the declared total.
 */
import type { PayrollPackCertificates } from "../certificates.ts";

export const JP_CERTIFICATES: PayrollPackCertificates = {
  country: "JP",
  certificates: [
    {
      key: "jp_fuyo",
      // Not a numbered form: the declaration has no preprinted number, so
      // the form names the declaration itself instead of inventing a code.
      form: "給与所得者の扶養控除等申告書",
      label: "Dependent exemption declaration for payroll withholding",
      scope: { level: "country" },
      purpose: "withholding",
      citation:
        "NTA No.2511 税額表の種類と使い方 "
        + "(https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2511.htm); "
        + "令和8年分 給与所得の源泉徴収税額表（月額表）備考",
      summary:
        "Filed with the payer at hiring and whenever the family position changes. "
        + "On file, the payer applies the 甲欄 at the declared dependent count; "
        + "without it, the payer applies the 乙欄.",
      storage: "certificate_rows",
      fields: [
        {
          key: "fuyo_count",
          label: "Dependents (源泉控除対象配偶者 + 源泉控除対象親族)",
          kind: "count",
          min: "0",
          max: "99",
          default: "0",
          help: "源泉控除対象配偶者と源泉控除対象親族との合計数, copied off the filed "
            + "declaration. Person-attribute additions below stack on top; a total "
            + "above 7 is refused by name (the 1,610円 rule is not transcribed).",
        },
        {
          key: "honnin_shogai",
          label: "The employee is 障害者 (incl. 特別障害者)",
          kind: "flag",
          help: "Adds one to the 扶養親族等の数 (No.2511: 障害者（特別障害者を含みます）"
            + "に該当するごとに1人を加算).",
        },
        {
          key: "hitori_oya",
          label: "The employee is ひとり親",
          kind: "flag",
          help: "Adds one to the 扶養親族等の数.",
        },
        {
          key: "kafu",
          label: "The employee is 寡婦",
          kind: "flag",
          help: "Adds one to the 扶養親族等の数.",
        },
        {
          key: "kinro_gakusei",
          label: "The employee is 勤労学生",
          kind: "flag",
          help: "Adds one to the 扶養親族等の数.",
        },
        {
          key: "kazoku_shogai_kasan",
          label: "Disabled family members (障害者/同居特別障害者 among spouse/dependents)",
          kind: "count",
          min: "0",
          max: "99",
          default: "0",
          help: "同一生計配偶者・扶養親族のうち障害者又は同居特別障害者に該当する人数 "
            + "— one added per person (No.2511).",
        },
      ],
    },
  ],
};
