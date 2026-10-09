// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2024-2026 Artem Boiko / DataDrivenConstruction.io, licensed under AGPL-3.0-or-later.
import type { ContractorWithholdingSchemeDefinition } from "./types.ts";

export const IT_CONDOMINIUM_WITHHOLDING: ContractorWithholdingSchemeDefinition = {
  code: "IT_RITENUTA_APPALTI", country: "IT",
  name: "Ritenuta sui corrispettivi dovuti dal condominio all'appaltatore",
  authority: "Agenzia delle Entrate", legalReference: "DPR 600/1973, art. 25-ter",
  currency: "EUR", payerScope: "condominium",
  base: { excludesMaterials: false, excludesVat: true },
  bands: [{ code: "STANDARD", name: "Condominium works and services withholding", requiresVerification: false,
    rates: [{ ratePercent: "4", effectiveFrom: "2007-01-01", sourceId: "ade_condominium_2007" }] }],
  defaultBandCode: "STANDARD", periodStartDay: 1,
  returnKind: "financial_workpaper", returnFrequency: "monthly",
  returnDue: null, paymentDue: null, paymentAuthorisation: "none",
  filingNotice: "This payment workpaper supports F24 remittances and annual recipient certification; it is not a statutory monthly return or a CU/770 transmission. Apply only to condominium payers and subject works or services; classify excluded supplies explicitly.",
  contractorReferenceLabel: "Condominium codice fiscale",
  payeeReferenceLabel: "Contractor codice fiscale", verificationLabel: "Subject contract evidence",
  remittanceSchedules: [
    { code: "IT_MONTHLY", name: "Monthly F24 remittance", kind: "monthly", effectiveFrom: "2007-01-01", dayOfMonth: 16, sourceId: "ade_condominium_2007" },
    { code: "IT_ACCUMULATED", name: "Accumulated €500 remittance", kind: "italian_accumulated", effectiveFrom: "2017-01-01", effectiveTo: "2023-12-31", accumulationThreshold: "500", mandatoryCutoffs: [{ month: 6, day: 30 }, { month: 12, day: 20 }], sourceId: "italy_condominium_remittance_2017" },
    { code: "IT_ACCUMULATED", name: "Accumulated €500 remittance", kind: "italian_accumulated", effectiveFrom: "2024-01-01", accumulationThreshold: "500", mandatoryCutoffs: [{ month: 6, day: 16 }, { month: 12, day: 16 }], sourceId: "italy_condominium_remittance_2024" },
  ],
  sources: [
    { id: "ade_condominium_2007", title: "Agenzia delle Entrate — Circolare 7/E, 7 February 2007", url: "https://def.giustiziatributaria.gov.it/DocTribFrontend/getPrassiDetail.do?id=%7BF784FF2B-8E3A-46CF-A6B9-DE8EECC8B712%7D", asOf: "2026-10-08" },
    { id: "italy_condominium_remittance_2017", title: "Gazzetta Ufficiale — Legge 232/2016, art. 1 comma 36", url: "https://www.gazzettaufficiale.it/eli/id/2016/12/21/16G00242/sg", asOf: "2026-10-08" },
    { id: "italy_condominium_remittance_2024", title: "Gazzetta Ufficiale — D.Lgs. 1/2024, art. 9", url: "https://www.gazzettaufficiale.it/eli/gu/2024/01/12/9/sg/pdf", asOf: "2026-10-08" },
    { id: "ade_condominium_august", title: "Agenzia delle Entrate — condominium August remittance deadline", url: "https://www1.agenziaentrate.gov.it/servizi/scadenzario/main.php?chi=3855&come=507&cosa=10991&entroil=20-08-2025&op=4", asOf: "2026-10-08" },
  ],
};

export const US_BACKUP_WITHHOLDING: ContractorWithholdingSchemeDefinition = {
  code: "US_BACKUP_WITHHOLDING", country: "US", name: "Backup withholding",
  authority: "Internal Revenue Service", legalReference: "IRC § 3406", currency: "USD",
  standingSource: "vendor_backup_withholding",
  base: { excludesMaterials: false, excludesVat: false },
  bands: [{ code: "BACKUP", name: "Vendor subject to backup withholding", requiresVerification: false,
    rates: [{ ratePercent: "24", effectiveFrom: "2018-01-01", sourceId: "irs_backup_withholding" }] }],
  defaultBandCode: "BACKUP", periodStartDay: 1,
  returnKind: "annual_945", returnFrequency: "annual",
  returnDue: { dayOfMonth: 31, monthsAfterPeriodEnd: 1 }, paymentDue: null, paymentAuthorisation: "none",
  filingNotice: "Annual backup-withholding evidence for Form 945 line 2. Combine all nonpayroll Form 945 liabilities when determining deposit schedules and thresholds; this contractor ledger does not replace other Form 945 withholding or certify deposits as timely. Recipient withholding also flows to 1099 box 4.",
  contractorReferenceLabel: "Payer EIN", payeeReferenceLabel: "Vendor TIN", verificationLabel: "Vendor backup-withholding flag",
  remittanceSchedules: [
    { code: "US_LOOKBACK", name: "Form 945 lookback determination", kind: "us_lookback", effectiveFrom: "2018-01-01", sourceId: "irs_945_deposits" },
    { code: "US_MONTHLY", name: "Form 945 monthly deposits", kind: "us_monthly", effectiveFrom: "2018-01-01", dayOfMonth: 15, sourceId: "irs_945_deposits" },
    { code: "US_SEMIWEEKLY", name: "Form 945 semiweekly deposits", kind: "us_semiweekly", effectiveFrom: "2018-01-01", sourceId: "irs_945_deposits" },
    { code: "US_ANNUAL_SMALL", name: "Final annual liability below $2,500", kind: "us_annual_small_liability", effectiveFrom: "2018-01-01", sourceId: "irs_945_deposits" },
  ],
  sources: [
    { id: "irs_backup_withholding", title: "IRS — backup withholding and Publication 963", url: "https://www.irs.gov/pub/irs-pdf/p963.pdf", asOf: "2026-10-08" },
    { id: "irs_945_deposits", title: "IRS — Instructions for Form 945", url: "https://www.irs.gov/instructions/i945", asOf: "2026-10-08" },
    { id: "irs_deposit_calendar", title: "IRS — Publication 15, deposit schedules and legal holidays", url: "https://www.irs.gov/publications/p15", asOf: "2026-10-08" },
  ],
};
