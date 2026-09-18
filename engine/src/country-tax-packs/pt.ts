import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const PT_IVA_DP_2026: TaxReturnPack = {
  code: "PT_IVA_DP",
  name: "Declaração Periódica de IVA",
  country: "PT",
  jurisdiction: { code: "PT", name: "Portugal — IVA territory", country: "PT", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://www.portaldasfinancas.gov.pt",
  watermark: "Working copy — review sede-territory treatment and ANEXO R regional operations, then file through the Portal das Finanças",
  boxes: [
    { lineCode: "1", label: "Campo 1 — base tributável das operações da sede em que liquidou imposto, à taxa reduzida", sign: 1, sequence: 10 },
    { lineCode: "2", label: "Campo 2 — IVA a favor do Estado à taxa reduzida", sign: -1, sequence: 20 },
    { lineCode: "5", label: "Campo 5 — base tributável das operações da sede em que liquidou imposto, à taxa intermédia", sign: 1, sequence: 30 },
    { lineCode: "6", label: "Campo 6 — IVA a favor do Estado à taxa intermédia", sign: -1, sequence: 40 },
    { lineCode: "3", label: "Campo 3 — base tributável das operações da sede em que liquidou imposto, à taxa normal", sign: 1, sequence: 50 },
    { lineCode: "4", label: "Campo 4 — IVA a favor do Estado à taxa normal", sign: -1, sequence: 60 },
    { lineCode: "20", label: "Campo 20 — IVA dedutível: imobilizado", sign: 1, sequence: 70 },
    { lineCode: "21", label: "Campo 21 — IVA dedutível: existências à taxa reduzida", sign: 1, sequence: 80 },
    { lineCode: "23", label: "Campo 23 — IVA dedutível: existências à taxa intermédia", sign: 1, sequence: 90 },
    { lineCode: "22", label: "Campo 22 — IVA dedutível: existências à taxa normal", sign: 1, sequence: 100 },
    { lineCode: "24", label: "Campo 24 — IVA dedutível: outros bens e serviços", sign: 1, sequence: 110 },
    { lineCode: "40", label: "Campo 40 — regularizações: base tributável", sign: 1, sequence: 120 },
    { lineCode: "41", label: "Campo 41 — regularizações: imposto", sign: 1, sequence: 130 },
    { lineCode: "61", label: "Campo 61 — excesso a reportar do período anterior (campo 96 da declaração anterior)", sign: 1, sequence: 140 },
    { lineCode: "81", label: "Campo 81 — regularizações a favor do sujeito passivo comunicadas pela DS Cobrança", sign: 1, sequence: 150 },
    { lineCode: "65", label: "Campo 65 — ANEXO R (operações noutro espaço territorial, 1.º anexo): imposto apurado no anexo", sign: 1, sequence: 160 },
    { lineCode: "66", label: "Campo 66 — ANEXO R (operações noutro espaço territorial, 1.º anexo): imposto apurado no anexo", sign: 1, sequence: 170 },
    { lineCode: "67", label: "Campo 67 — ANEXO R (operações noutro espaço territorial, 2.º anexo): imposto apurado no anexo", sign: 1, sequence: 180 },
    { lineCode: "68", label: "Campo 68 — ANEXO R (operações noutro espaço territorial, 2.º anexo): imposto apurado no anexo", sign: 1, sequence: 190 },
    { lineCode: "90", label: "Campo 90 — total da base tributável", sign: 1, sequence: 200 },
    { lineCode: "91", label: "Campo 91 — total do IVA a favor do sujeito passivo", sign: 1, sequence: 210 },
    { lineCode: "92", label: "Campo 92 — total do IVA a favor do Estado", sign: -1, sequence: 220 },
    { lineCode: "93", label: "Campo 93 — imposto a entregar ao Estado", sign: -1, sequence: 230 },
    { lineCode: "94", label: "Campo 94 — crédito de imposto a recuperar", sign: 1, sequence: 240 },
    { lineCode: "95", label: "Campo 95 — pedido de reembolso", sign: 1, sequence: 250 },
    { lineCode: "96", label: "Campo 96 — excesso a reportar para o período seguinte", sign: 1, sequence: 260 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates and territories", sign: -1, sequence: 270, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates and territories", sign: 1, sequence: 280, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Portugal IVA localization.
 *
 * One national return, three rate territories. The Declaração Periódica is
 * filed once per taxable person: Quadro 03 fixes the sede territory
 * (Continente, Açores or Madeira), campos 1–16 and 20–24 report only
 * sede-territory operations, and operations deemed effected in another
 * territory (Decreto-Lei n.º 347/85) consolidate into the same return via
 * ANEXO R (Quadro 04) with annex totals in campos 65–68. No territory files
 * separately, so the regions are rate bands on PT_IVA_DP — nine codes with
 * the territory in each code's name — and `jurisdictions` stays empty.
 *
 * Monthly by default (CIVA art. 41.º: monthly at or above €650,000
 * prior-year turnover; quarterly below, with an option to file monthly —
 * that election is unmodelled).
 *
 * Rate tails are left-truncated applicability, not origins: pre-July-2010
 * origins, the Madeira reduced band before October 2024, and the Açores
 * normal band before July 2021 are explicitly refused (see completeness).
 * Lista I / Lista II taxability, DL 347/85 sourcing detail, and the 06-A /
 * recapitulativa developments are out of scope.
 *
 * SOURCING: three citations are professional-body mirrors of DSIVA material,
 * kept as named id-specific exceptions (wave5 proof): `at_dp_modelo_instrucoes`
 * (the Declaração Periódica form and filling instructions via aproces.org),
 * `dsiva_oc30118_2010_aplicabilidade` (DSIVA Ofício 30118/2010 via the OCC
 * accountants' Order mirror) and `dsiva_oc30121_2010_taxa_normal` (DSIVA Ofício
 * 30121/2010 via APECA). The AT portal's instruções archive holds no
 * DSIVA-era (pre-AT, 2010) ofícios and the Diário da República PDFs are not
 * retrievable from this sandbox, so the enabling laws (Lei 12-A/2010 for the
 * July 2010 bands, Lei 55-A/2010 for the 23% band) could not be re-sourced
 * from the authority. Both ofício texts were read in full and state exactly
 * the rates and dates the rows claim; truncating to post-2021 AT ofícios
 * would delete the whole Continente history, so the mirrors stay named.
 */
export const PORTUGAL_TAX_PACK: CountryTaxPackDefinition = {
  code: "PT_INDIRECT_TAX",
  version: "2026.08.01",
  country: "PT",
  name: "Portugal",
  countryTaxType: "vat",
  parentReturnPackCode: "PT_IVA_DP",
  completeness: {
    jurisdictions: "complete",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "at_portal_entrega_dp",
      title: "AT Portal das Finanças — electronic filing entry point for the Declaração Periódica (Contribuintes, Entregar, IVA)",
      url: "https://www.portaldasfinancas.gov.pt",
      asOf: "2026-09-18",
    },
    {
      id: "at_civa_art41_periodicidade",
      title: "AT CIVA art. 41.º — monthly/quarterly filing thresholds and deadlines for the declaração periódica",
      url: "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/civa_rep/Pages/iva41.aspx",
      asOf: "2026-09-18",
    },
    {
      id: "at_dp_modelo_instrucoes",
      title: "Declaração Periódica de IVA — official form and filling instructions (Quadros 03/04/06, campos 1–96), via professional-body mirror",
      url: "https://www.aproces.org/wp-content/uploads/2019/10/IVA-declaracao_periodica_IVA.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "dsiva_oc30118_2010_aplicabilidade",
      title: "DSIVA Ofício 30118/2010 — 6%/13%/21% (Continente) and 4%/9%/15% (regions) applicability from 1 July 2010; pre-July origins not transcribed",
      url: "https://cihc.occ.pt/fotos/editor2/Oficio-Circulado.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "dsiva_oc30121_2010_taxa_normal",
      title: "DSIVA Ofício 30121/2010 — normal rate 23% (Continente) from 1 January 2011 (Lei 55-A/2010)",
      url: "https://www.apeca.pt/docs/apeca-documentos/oc_circ_30121_2010.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "at_oc30237_2021_acores",
      title: "AT Ofício Circulado 30237/2021 — Açores normal rate 18% to 16% from 1 July 2021 (DLR 15-A/2021/A); 4%/9% unchanged",
      url: "https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/legislacao/instrucoes_administrativas/Documents/Oficio_circulado_30237_2021.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "at_oc25045_2024_madeira",
      title: "AT Ofício Circulado 25045/2024 — Madeira rates: 22%/12% since 1 April 2012 (Lei 14-A/2012), reduced 4% from 1 October 2024 (DLR 6/2024/M)",
      url: "https://at.madeira.gov.pt/ficheiros/Oficio_circulado_25045_2024.pdf",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [PT_IVA_DP_2026],
  returnPackTaxCodes: {
    PT_IVA_DP: [
      {
        code: "PT-VAT-STD",
        name: "Continente IVA standard 23%",
        ratePercent: 23,
        role: "standard",
        rates: [
          { ratePercent: 21, effectiveFrom: "2010-07-01", effectiveTo: "2010-12-31", sourceId: "dsiva_oc30118_2010_aplicabilidade" },
          { ratePercent: 23, effectiveFrom: "2011-01-01", sourceId: "dsiva_oc30121_2010_taxa_normal" },
        ],
      },
      {
        code: "PT-VAT-INT",
        name: "Continente IVA intermediate 13%",
        ratePercent: 13,
        role: "reduced",
        rates: [{ ratePercent: 13, effectiveFrom: "2010-07-01", sourceId: "dsiva_oc30118_2010_aplicabilidade" }],
      },
      {
        code: "PT-VAT-RED",
        name: "Continente IVA reduced 6%",
        ratePercent: 6,
        role: "reduced",
        rates: [{ ratePercent: 6, effectiveFrom: "2010-07-01", sourceId: "dsiva_oc30118_2010_aplicabilidade" }],
      },
      {
        code: "PT-MAD-VAT-STD",
        name: "Madeira IVA standard 22%",
        ratePercent: 22,
        role: "standard",
        rates: [{ ratePercent: 22, effectiveFrom: "2012-04-01", sourceId: "at_oc25045_2024_madeira" }],
      },
      {
        code: "PT-MAD-VAT-INT",
        name: "Madeira IVA intermediate 12%",
        ratePercent: 12,
        role: "reduced",
        rates: [{ ratePercent: 12, effectiveFrom: "2012-04-01", sourceId: "at_oc25045_2024_madeira" }],
      },
      {
        code: "PT-MAD-VAT-RED",
        name: "Madeira IVA reduced 4%",
        ratePercent: 4,
        role: "reduced",
        rates: [{ ratePercent: 4, effectiveFrom: "2024-10-01", sourceId: "at_oc25045_2024_madeira" }],
      },
      {
        code: "PT-AZO-VAT-STD",
        name: "Açores IVA standard 16%",
        ratePercent: 16,
        role: "standard",
        rates: [{ ratePercent: 16, effectiveFrom: "2021-07-01", sourceId: "at_oc30237_2021_acores" }],
      },
      {
        code: "PT-AZO-VAT-INT",
        name: "Açores IVA intermediate 9%",
        ratePercent: 9,
        role: "reduced",
        rates: [{ ratePercent: 9, effectiveFrom: "2010-07-01", sourceId: "dsiva_oc30118_2010_aplicabilidade" }],
      },
      {
        code: "PT-AZO-VAT-RED",
        name: "Açores IVA reduced 4%",
        ratePercent: 4,
        role: "reduced",
        rates: [{ ratePercent: 4, effectiveFrom: "2010-07-01", sourceId: "dsiva_oc30118_2010_aplicabilidade" }],
      },
    ],
  },
};
