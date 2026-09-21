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
import {
  BR_2024_EDITION_LABEL_FEB,
  BR_2024_EDITION_LABEL_JAN,
} from "./tax-year-2024.ts";
import {
  BR_2025_EDITION_LABEL_EARLY,
  BR_2025_EDITION_LABEL_LATE,
} from "./tax-year-2025.ts";
import { BR_2026_EDITION_LABEL } from "./tax-year-2026.ts";

export const BR_RATES_MODULE = "engine/src/payroll/br/tax-year-2026.ts";

export const BR_TAX_YEARS: PayrollTaxYearSupport = {
  country: "BR",
  editions: [
    {
      year: 2024,
      label: `2024 monthly CLT, January (INSS Portaria 2/2024 + IRRF Lei 14.663/2023 item X): ${BR_2024_EDITION_LABEL_JAN}`,
      effectiveFrom: "2024-01-01",
      citation:
        "Portaria Interministerial MPS/MF nº 2, de 11/1/2024 (DOU 12/1/2024); "
        + "Lei 14.663/2023 art. 5º item X; Lei 9.250/1995 art. 4º (R$ 189,59/dependente, 25% simplificado)",
      status: "published",
    },
    {
      year: 2024,
      label: `2024 monthly CLT, February–December (INSS Portaria 2/2024 + IRRF Lei 14.848/2024 item XI): ${BR_2024_EDITION_LABEL_FEB}`,
      effectiveFrom: "2024-02-01",
      citation:
        "Portaria Interministerial MPS/MF nº 2, de 11/1/2024 (DOU 12/1/2024); "
        + "Lei 14.848/2024 art. 1º item XI; RFB official 2024 tabelas page; "
        + "Lei 9.250/1995 art. 4º (R$ 189,59/dependente, 25% simplificado)",
      status: "published",
    },
    {
      year: 2025,
      label: `2025 monthly CLT, January–April (INSS Portaria 6/2025 + IRRF Lei 14.848/2024 item XI): ${BR_2025_EDITION_LABEL_EARLY}`,
      effectiveFrom: "2025-01-01",
      citation:
        "Portaria Interministerial MPS/MF nº 6, de 10/1/2025 (DOU 13/1/2025); "
        + "Lei 14.848/2024 art. 1º item XI; RFB official 2025 tabelas page; "
        + "Lei 9.250/1995 art. 4º (R$ 189,59/dependente, 25% simplificado)",
      status: "published",
    },
    {
      year: 2025,
      label: `2025 monthly CLT, May–December (INSS Portaria 6/2025 + IRRF Lei 15.191/2025 item XII): ${BR_2025_EDITION_LABEL_LATE}`,
      effectiveFrom: "2025-05-01",
      citation:
        "Portaria Interministerial MPS/MF nº 6, de 10/1/2025 (DOU 13/1/2025); "
        + "Lei 15.191/2025 art. 2º item XII (ex MP 1.294/2025); RFB official 2025 tabelas page; "
        + "Lei 9.250/1995 art. 4º (R$ 189,59/dependente, 25% simplificado)",
      status: "published",
    },
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
      {
        path: "engine/src/payroll/br/tax-year-2024.ts",
        purpose:
          "2024 tables: one INSS table plus the January vs February–December IRRF editions",
        template:
          "Transcribe the January Portaria Anexo II once and each in-force IRRF monthly table "
          + "(Lei 14.663/2023 item X for January, Lei 14.848/2024 item XI from February) as its own edition.",
      },
      {
        path: "engine/src/payroll/br/tax-year-2025.ts",
        purpose:
          "2025 tables: one INSS table plus the January–April vs May–December IRRF editions",
        template:
          "Transcribe the January Portaria Anexo II once and each in-force IRRF monthly table "
          + "(Lei 14.848/2024 item XI through April, Lei 15.191/2025 item XII from May) as its own edition.",
      },
    ],
    barrels: [],
    steps: [
      "Fetch the January Portaria Interministerial (DOU) and transcribe its Anexo II brackets and teto.",
      "Transcribe EVERY IRRF Tabela Progressiva Mensal in force during the year — Brazil reprices "
      + "mid-year (February 2024, May 2025): each table is its own edition with its own effectiveFrom.",
      "Transcribe the Lei 15.270-style monthly reduction only when in force for the year (2026+).",
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
      // The engine already refuses an undeclared establishment rate by name;
      // the declaration records that refusal here.
      whenUnconfigured: "refuse",
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
      // The engine already refuses an undeclared establishment factor by
      // name; the declaration records that refusal here.
      whenUnconfigured: "refuse",
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
      // The engine already refuses an undeclared establishment percent by
      // name; the declaration records that refusal here.
      whenUnconfigured: "refuse",
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
