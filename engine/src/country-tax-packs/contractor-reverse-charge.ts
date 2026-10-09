// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2024-2026 Artem Boiko / DataDrivenConstruction.io, licensed under AGPL-3.0-or-later.
import type { ContractorReverseChargeRuleDefinition } from "./types.ts";

const rule = (
  definition: Omit<ContractorReverseChargeRuleDefinition, "calculationType" | "einvoiceCategory" | "effectiveFrom">,
): ContractorReverseChargeRuleDefinition => ({
  ...definition,
  calculationType: "reverse_charge",
  einvoiceCategory: "AE",
  // Current authority-reviewed scope; earlier invoice policies need their own effective version.
  effectiveFrom: "2026-10-08",
});

export const CONSTRUCTION_REVERSE_CHARGE_RULES: readonly ContractorReverseChargeRuleDefinition[] = [
  rule({
    code: "GB_DRC_CONSTRUCTION", country: "GB", name: "Construction domestic reverse charge",
    legalReference: "VAT Act 1994, s. 55A",
    invoiceWording: "Reverse charge: VAT Act 1994 Section 55A applies. Customer to pay the VAT to HMRC.",
    applicability: "Specified CIS construction services between UK VAT-registered businesses; written end-user or intermediary-supplier notifications exclude the supply.",
    sources: [{ id: "hmrc_construction_reverse_charge", title: "HMRC — VAT domestic reverse charge technical guide", url: "https://www.gov.uk/guidance/vat-reverse-charge-technical-guide", asOf: "2026-10-08" }],
  }),
  rule({
    code: "DE_13B_USTG", country: "DE", name: "Steuerschuldnerschaft des Leistungsempfängers",
    legalReference: "UStG § 13b Abs. 2 Nr. 4, Abs. 5; § 14a Abs. 5",
    invoiceWording: "Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG).",
    applicability: "Construction services received by an entrepreneur who sustainably supplies construction services; planning and supervision are excluded. The income-tax withholding under EStG § 48 remains independent.",
    sources: [{ id: "german_construction_reverse_charge", title: "Federal Ministry of Justice — UStG § 13b", url: "https://www.gesetze-im-internet.de/ustg_1980/__13b.html", asOf: "2026-10-08" }],
  }),
  rule({
    code: "ES_ISP_CONSTRUCTION", country: "ES", name: "Inversión del sujeto pasivo",
    legalReference: "Ley 37/1992, art. 84.Uno.2.f)",
    invoiceWording: "Inversión del sujeto pasivo (art. 84.Uno.2.f de la Ley 37/1992).",
    applicability: "Works and assigned personnel under contracts for land development or construction or rehabilitation of buildings, between developer and contractor and throughout the subcontracting chain; ordinary repairs are not automatically rehabilitation.",
    sources: [{ id: "spanish_construction_reverse_charge", title: "BOE — Ley 37/1992, artículo 84", url: "https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740#a84", asOf: "2026-10-08" }],
  }),
  rule({
    code: "FR_AUTOLIQUIDATION_BTP", country: "FR", name: "Autoliquidation de la TVA dans le bâtiment",
    legalReference: "CGI, art. 283, 2 nonies",
    invoiceWording: "Autoliquidation — article 283, 2 nonies du CGI. TVA due par le preneur.",
    applicability: "Construction, repair, cleaning, maintenance, alteration and demolition related to real property, performed by a subcontractor for a taxable recipient; verify the supplier's VAT exemption status separately.",
    sources: [{ id: "french_construction_reverse_charge", title: "DGFiP — construction subcontracting reverse charge", url: "https://bofip.impots.gouv.fr/bofip/3218-PGP.html/identifiant=BOI-TVA-DECLA-10-10-20-20230118", asOf: "2026-10-08" }],
  }),
  rule({
    code: "IE_RCT_REVERSE_CHARGE", country: "IE", name: "Construction services reverse charge",
    legalReference: "VAT Consolidation Act 2010, s. 16(3)",
    invoiceWording: "VAT on this supply to be accounted for by the Principal Contractor.",
    applicability: "Construction services supplied by a subcontractor to an RCT principal contractor, and applicable connected-person construction supplies. Do not apply the construction rule to forestry, meat processing or haulage merely because RCT applies.",
    sources: [{ id: "irish_construction_reverse_charge", title: "Revenue — VAT treatment of construction services", url: "https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part11-immovable-goods/construction-services/construction-servcies-20250102075627.pdf", asOf: "2026-10-08" }],
  }),
  rule({
    code: "HU_FORDITOTT_ADOZAS_EPITES", country: "HU", name: "Fordított adózás építési-szerelési munkáknál",
    legalReference: "Áfa tv. 142. § (1) b), (3); 169. § n)",
    invoiceWording: "Fordított adózás",
    applicability: "Construction or assembly affecting real property and requiring the relevant official permit or notification, with the statutory domestic VAT-party conditions and prior written declaration; unrelated waste, safety or qualification permits do not establish scope.",
    sources: [{ id: "hungarian_construction_reverse_charge", title: "NAV — 2026/4 construction permit and notification conditions", url: "https://nav.gov.hu/ado/adozasi_kerdes/20264.-adozasi-kerdes---hatosagi-engedelyhez-es-bejelenteshez-kotottsegre-vonatkozo-feltetel-a-belfoldi-forditott-adozas-ala-tartozo-ugyletek-eseteben", asOf: "2026-10-08" }],
  }),
];

export const constructionReverseChargeRulesForCountry = (country: string): readonly ContractorReverseChargeRuleDefinition[] =>
  CONSTRUCTION_REVERSE_CHARGE_RULES.filter((definition) => definition.country === country);
