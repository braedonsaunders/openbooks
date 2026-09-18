import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const TR_KDV1_2026: TaxReturnPack = {
  code: "TR_KDV1",
  name: "KDV1 Beyannamesi — Katma Değer Vergisi Beyannamesi (1 No.lu)",
  country: "TR",
  jurisdiction: { code: "TR", name: "Türkiye — KDV territory", country: "TR", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://dijital.gib.gov.tr/",
  watermark: "Working copy — review list I/II classification, then file through Dijital Vergi Dairesi (e-Beyanname); tevkifat (KDV2) and ÖTV are out of scope",
  boxes: [
    { lineCode: "MATRAH-20", label: "Matrah (taxable base) — genel oranda (%20) vergilendirilen teslim ve hizmetler", sign: 1, sequence: 10 },
    { lineCode: "HESAPLANAN-20", label: "Hesaplanan KDV (output VAT charged) — %20 genel oran", sign: -1, sequence: 20 },
    { lineCode: "MATRAH-10", label: "Matrah (taxable base) — %10 indirimli orana tabi teslim ve hizmetler", sign: 1, sequence: 30 },
    { lineCode: "HESAPLANAN-10", label: "Hesaplanan KDV (output VAT charged) — %10 indirimli oran", sign: -1, sequence: 40 },
    { lineCode: "MATRAH-1", label: "Matrah (taxable base) — %1 indirimli orana tabi teslim ve hizmetler", sign: 1, sequence: 50 },
    { lineCode: "HESAPLANAN-1", label: "Hesaplanan KDV (output VAT charged) — %1 indirimli oran", sign: -1, sequence: 60 },
    { lineCode: "INDIRILECEK-KDV", label: "İndirilecek KDV (deductible VAT) — bu döneme ait indirilecek KDV toplamı, İndirimler kulakçığı (108/109/110 ve diğer indirim türleri)", sign: 1, sequence: 70 },
    { lineCode: "ODENECEK-KDV", label: "Ödenecek KDV (VAT payable) — hesaplanan KDV toplamından indirilecek KDV düşüldükten sonra kalan", sign: 1, sequence: 80 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 90, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 100, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Türkiye KDV localization. KDV is national — no subnational indirect tax.
 * Out of scope by name: ÖTV (special consumption tax) and the
 * withholding/tevkifat regime (KDV2, sorumlu sıfatıyla beyan).
 *
 * Box codes are descriptive Turkish names: GİB publishes the KDV1 as tabbed
 * e-Beyanname tables (Matrah / İndirimler kulakçıkları) with per-table
 * transaction-type codes, not stable public numeric box codes, so there are
 * no Casilla-style numbers to transcribe.
 */
export const TURKIYE_TAX_PACK: CountryTaxPackDefinition = {
  code: "TR_INDIRECT_TAX",
  version: "2026.08.01",
  country: "TR",
  name: "Türkiye",
  countryTaxType: "vat",
  parentReturnPackCode: "TR_KDV1",
  completeness: {
    jurisdictions: "partial",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "partial",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "rg_7346_kdv_2023",
      title: "Resmî Gazete 07.07.2023 sayı 32241 — 7346 sayılı Cumhurbaşkanı Kararı: genel oran %18'den %20'ye, (II) sayılı liste %8'den %10'a, yürürlük 10.07.2023",
      url: "https://www.resmigazete.gov.tr/eskiler/2023/07/20230707-11.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "sovos_tr_kdv_july2023",
      title: "Sovos regulatory update — 18% to 20% and 8% to 10% effective 10 July 2023 per Presidential Decree 7346, with link to the Resmî Gazete PDF",
      url: "https://sovos.com/regulatory-updates/vat/turkiye-increases-vat-rates-effective-july-10-2023/",
      asOf: "2026-09-18",
    },
    {
      id: "trustus_tr_kdv_table",
      title: "TrustUs Türkiye KDV guide — 1% basic-goods band unaffected by the July 2023 increase, 8% to 10%, 18% to 20%",
      url: "https://trustusconsultancy.com/en/value-added-tax-turkey-kdv/",
      asOf: "2026-09-18",
    },
    {
      id: "sirkuler_2008_03_baseline",
      title: "Applicability of the 2007/13033 schedule (%18 / %1 / %8) from 2008 — RG 30.12.2007 sayı 26742, 2008 yılında geçerli (left-truncated: no origin claimed before 2008)",
      url: "https://www.bilgidenetim.com.tr/srk/2008-03.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "gib_dvd_portal",
      title: "GİB Dijital Vergi Dairesi — live filing portal with user login (Kullanıcı Girişi); e-Beyanname access pages closed into single sign-on per VUK Genel Tebliği 552",
      url: "https://dijital.gib.gov.tr/",
      asOf: "2026-09-18",
    },
    {
      id: "gib_ebeyan_doc",
      title: "GİB e-Beyan dokümantasyon merkezi — publishes the KDV1 beyanname guides and version duyuruları; a document venue, no machine lodging API confirmed",
      url: "https://ebeyan.gib.gov.tr/beyan-doc/",
      asOf: "2026-09-18",
    },
    {
      id: "kdv1_v41_duyuru_mirror",
      title: "Mirror of the GİB KDV1 41. versiyon duyuru — real table and field names (Özel Matrah Tablosu, Bildirim/İşlem Türü, Toplam Matrah, Teslim ve Hizmetlerin Karşılığını Teşkil Eden Bedel)",
      url: "https://www.alomaliye.com/wp-content/uploads/2025/10/kdv-41-duyuru.pdf",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [TR_KDV1_2026],
  returnPackTaxCodes: {
    TR_KDV1: [
      {
        code: "TR-VAT-STD",
        name: "Türkiye general-rate KDV",
        ratePercent: 20,
        role: "standard",
        rates: [
          { ratePercent: 18, effectiveFrom: "2008-01-01", effectiveTo: "2023-07-09", sourceId: "sirkuler_2008_03_baseline" },
          { ratePercent: 20, effectiveFrom: "2023-07-10", sourceId: "rg_7346_kdv_2023" },
        ],
      },
      {
        code: "TR-VAT-RED10",
        name: "Türkiye reduced KDV 10% (liste II)",
        ratePercent: 10,
        role: "reduced",
        rates: [
          { ratePercent: 8, effectiveFrom: "2008-01-01", effectiveTo: "2023-07-09", sourceId: "sirkuler_2008_03_baseline" },
          { ratePercent: 10, effectiveFrom: "2023-07-10", sourceId: "rg_7346_kdv_2023" },
        ],
      },
      {
        code: "TR-VAT-RED1",
        name: "Türkiye reduced KDV 1% (liste I, basic foodstuffs)",
        ratePercent: 1,
        role: "reduced",
        rates: [{ ratePercent: 1, effectiveFrom: "2008-01-01", sourceId: "sirkuler_2008_03_baseline" }],
      },
    ],
  },
};
