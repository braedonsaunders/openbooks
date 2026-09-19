/**
 * BR pack rate declarations: which 2026 editions are transcribed, and the
 * employer rates no publication can supply.
 *
 * RAT/FAP/terceiros follow France's AT/MP precedent: tenant-declared slots
 * on the establishment filing account (the eSocial CNPJ), refused by name at
 * lookup when undeclared — the CNAE risk class and accident history are
 * unknowable to the pack, so they are never table-supplied.
 */
import type { PayrollTaxYearSupport } from "../tax-years.ts";
import type { PayrollPackRates } from "../statutory-rates.ts";
import { BR_2026_EDITION_LABEL } from "./tax-year-2026.ts";

export const BR_RATES_MODULE = "engine/src/payroll/br/tax-year-2026.ts";

export const BR_TAX_YEARS: PayrollTaxYearSupport = {
  country: "BR",
  editions: [
    {
      year: 2026,
      label: `2026 monthly CLT (INSS Portaria 13/2026 + IRRF Lei 15.270/2025 art. 3º-A): ${BR_2026_EDITION_LABEL}`,
      effectiveFrom: "2026-01-01",
      citation:
        "Portaria Interministerial MPS/MF nº 13, de 9/1/2026 (DOU 12/1/2026); "
        + "Lei 11.482/2007 art. 1º XII (MP 1.294/2025); Lei 15.270/2025; "
        + "Lei 9.250/1995 arts. 4º e 10",
      status: "published",
    },
  ],
  regionsWithOwnTables: [],
  ratesModule: BR_RATES_MODULE,
  scaffold: {
    files: [
      {
        path: BR_RATES_MODULE,
        purpose:
          "INSS contribution brackets and IRRF monthly bands/reduction, versioned by year",
        template:
          "Transcribe the year's Portaria Interministerial (DOU, January) Anexo I "
          + "and the year's IRRF monthly table + art. 3º-A reduction beside the {priorYear} edition.",
      },
    ],
    barrels: [],
    steps: [
      "Fetch the January Portaria Interministerial (DOU) and transcribe its Anexo I brackets and teto.",
      "Transcribe the IRRF Tabela Progressiva Mensal and the Lei 15.270-style monthly reduction in force for the year.",
      "Transcribe or explicitly refuse 13º, férias and rescisão for the year.",
      "Add golden stubs and flip the pack to installable.",
    ],
  },
};

export const BR_PACK_RATES: PayrollPackRates = {
  country: "BR",
  slots: [
    {
      key: "br_rat",
      label: "RAT (riscos ambientais do trabalho)",
      // Per establishment: the rate rides the eSocial CNPJ filing account —
      // the CNAE risk class (leve/médio/grave → 1%/2%/3%) belongs to the
      // establishment, never to the org as a whole.
      scope: "filing_account",
      programType: "br_cnpj_esocial",
      systemKeys: ["inss_rat"],
      regions: ["BR"],
      citation: "Lei nº 8.212/1991, art. 22, II (1%, 2% ou 3% conforme o risco da atividade preponderante)",
      variesBecause:
        "The rate is 1%, 2% or 3% from the establishment's CNAE risk grade — a figure no published table can supply.",
      fields: [
        {
          key: "aliquota", label: "RAT (%)", kind: "percent", decimals: 2,
          min: "1", max: "3", required: true,
          help: "As a percent, as the establishment's CNAE risk grade sets it: 1, 2 or 3.",
        },
      ],
    },
    {
      key: "br_fap",
      label: "FAP (fator acidentário de prevenção)",
      // Per establishment, same account as RAT: it multiplies the RAT rate
      // from that establishment's own accident history.
      scope: "filing_account",
      programType: "br_cnpj_esocial",
      systemKeys: ["inss_rat"],
      regions: ["BR"],
      citation: "Lei nº 10.666/2003, art. 10 (multiplicador de 0,5 a 2,0 sobre a alíquota RAT)",
      variesBecause:
        "The factor is computed per establishment from its own accident/sinistrality history — a figure no published table can supply.",
      fields: [
        {
          // A factor, not a percent: 1.0000 is neutral. Labelled as such so
          // no operator types 100 for 1.0 (the silent ×100 hazard).
          key: "fator", label: "FAP (fator, não percentual)", kind: "rate", decimals: 4,
          min: "0.5", max: "2", required: true,
          help: "As a factor exactly as the annual FAP notice states it: 1.0000 is neutral, 0.5000 halves the RAT rate, 2.0000 doubles it.",
        },
      ],
    },
    {
      key: "br_terceiros",
      label: "Terceiros (Sistema S / salário-educação / INCRA)",
      // Per establishment FPAS code, same account: the aggregate percent
      // depends on which third parties the activity contributes to.
      scope: "filing_account",
      programType: "br_cnpj_esocial",
      systemKeys: ["inss_terceiros"],
      regions: ["BR"],
      citation: "Contribuições a terceiros (Sistema S, salário-educação, INCRA) conforme o código FPAS do estabelecimento",
      variesBecause:
        "The aggregate terceiros percent depends on the establishment's FPAS code (which Sistema S entities it funds) — a figure no published table can supply.",
      fields: [
        {
          key: "aliquota", label: "Terceiros (%)", kind: "percent", decimals: 2,
          min: "0", max: "20", required: true,
          help: "As a percent: the sum of the establishment's own terceiros contributions for its FPAS code — never a guessed total.",
        },
      ],
    },
  ],
};
