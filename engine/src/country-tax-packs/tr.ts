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
 *
 * SOURCING: zero vendor citations. The baseline rows rest on the gazette
 * instrument itself — Bakanlar Kurulu Kararı 2007/13033, Resmî Gazete
 * 30.12.2007 sayı 26742, decided 24/12/2007 under KDV Kanunu md. 28 ve 36,
 * read at the gazette's own URL
 * https://www.resmigazete.gov.tr/eskiler/2007/12/20071230-4.htm by a host
 * whose network reaches resmigazete.gov.tr (this sandbox's TLS cannot; a
 * sandbox limitation, recorded per the pack-fleet fetch rules). Operative
 * Madde 1 — the legacy page encoding strips Turkish diacritics, the
 * figures are unambiguous:
 *
 * > Mal teslimleri ile hizmet ifalarına uygulanacak katma değer vergisi
 * > oranları; a) Ekli listelerde yer alanlar hariç olmak üzere, vergiye
 * > tabi işlemler için, % 18 b) Ekli (I) sayılı listede yer alan teslim ve
 * > hizmetler için, % 1 c) Ekli (II) sayılı listede yer alan teslim ve
 * > hizmetler için, % 8 olarak tespit edilmiştir.
 *
 * Commencement is Madde 4, not the publication date: financial-leasing
 * rules apply from publication for later contracts, List II rows A/13-b,
 * A/14, A/18-b and B/24, B/25 join 1/1/2008, and the remaining provisions
 * — including the Madde 1 rate sentence — take effect the day after
 * publication, 31.12.2007. Baseline rows therefore open 2007-12-31; the
 * 1/1/2008 list-membership refinements are below this pack's band
 * granularity and are named here, not modelled.
 *
 * Deleted vendor entries, cited by zero rate rows: `sovos_tr_kdv_july2023`,
 * `trustus_tr_kdv_table`, `kdv1_v41_duyuru_mirror`, and the
 * `sirkuler_2008_03_baseline` professional circular the gazette instrument
 * supersedes. Box/table names were transcribed from the GİB KDV1 v41
 * duyuru text; boxes carry no source pointers, so no citation entry
 * remains for them.
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
      id: "rg_2007_13033_baseline",
      title: "Resmî Gazete 30.12.2007 sayı 26742 — BKK 2007/13033: genel oran %18, (I) sayılı liste %1, (II) sayılı liste %8; Madde 4 ile diğer hükümler 31.12.2007'de yürürlükte",
      url: "https://www.resmigazete.gov.tr/eskiler/2007/12/20071230-4.htm",
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
          { ratePercent: 18, effectiveFrom: "2007-12-31", effectiveTo: "2023-07-09", sourceId: "rg_2007_13033_baseline" },
          { ratePercent: 20, effectiveFrom: "2023-07-10", sourceId: "rg_7346_kdv_2023" },
        ],
      },
      {
        code: "TR-VAT-RED10",
        name: "Türkiye reduced KDV 10% (liste II)",
        ratePercent: 10,
        role: "reduced",
        rates: [
          { ratePercent: 8, effectiveFrom: "2007-12-31", effectiveTo: "2023-07-09", sourceId: "rg_2007_13033_baseline" },
          { ratePercent: 10, effectiveFrom: "2023-07-10", sourceId: "rg_7346_kdv_2023" },
        ],
      },
      {
        code: "TR-VAT-RED1",
        name: "Türkiye reduced KDV 1% (liste I, basic foodstuffs)",
        ratePercent: 1,
        role: "reduced",
        rates: [{ ratePercent: 1, effectiveFrom: "2007-12-31", sourceId: "rg_2007_13033_baseline" }],
      },
    ],
  },
};
