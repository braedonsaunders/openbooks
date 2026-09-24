import type { CountryTaxPackDefinition, TaxReturnPack } from "./types.ts";

const VN_GTGT_01: TaxReturnPack = {
  code: "VN_GTGT_01",
  name: "Tờ khai thuế GTGT — Mẫu 01/GTGT (phương pháp khấu trừ)",
  country: "VN",
  jurisdiction: { code: "VN", name: "Vietnam", country: "VN", level: "country", taxType: "vat" },
  defaultFrequency: "monthly",
  submissionChannel: "portal_manual",
  governmentFormat: "portal_entry",
  submissionUrl: "https://thuedientu.gdt.gov.vn",
  watermark: "Working copy — confirm the filing period on the e-tax portal, then file the 01/GTGT return with the General Department of Taxation",
  boxes: [
    { lineCode: "27", label: "Chỉ tiêu [27] — hàng hóa, dịch vụ bán ra chịu thuế GTGT (doanh thu chưa thuế)", sign: 1, sequence: 10 },
    { lineCode: "28", label: "Chỉ tiêu [28] — thuế GTGT đầu ra của hàng hóa, dịch vụ bán ra chịu thuế", sign: -1, sequence: 20 },
    { lineCode: "29", label: "Chỉ tiêu [29] — hàng hóa, dịch vụ bán ra chịu thuế suất 0%", sign: 1, sequence: 30 },
    { lineCode: "30", label: "Chỉ tiêu [30] — hàng hóa, dịch vụ bán ra chịu thuế suất 5% (doanh thu)", sign: 1, sequence: 40 },
    { lineCode: "31", label: "Chỉ tiêu [31] — thuế GTGT của hàng hóa, dịch vụ bán ra chịu thuế suất 5%", sign: -1, sequence: 50 },
    { lineCode: "32", label: "Chỉ tiêu [32] — hàng hóa, dịch vụ bán ra chịu thuế suất 10% (doanh thu)", sign: 1, sequence: 60 },
    { lineCode: "33", label: "Chỉ tiêu [33] — thuế GTGT của hàng hóa, dịch vụ bán ra chịu thuế suất 10%", sign: -1, sequence: 70 },
    { lineCode: "25", label: "Chỉ tiêu [25] — thuế GTGT của hàng hóa, dịch vụ mua vào được khấu trừ kỳ này", sign: 1, sequence: 80 },
    { lineCode: "36", label: "Chỉ tiêu [36] — thuế GTGT phát sinh trong kỳ ([35]−[25])", sign: 1, sequence: 90 },
    { lineCode: "40", label: "Chỉ tiêu [40] — thuế GTGT còn phải nộp trong kỳ ([40a]−[40b])", sign: 1, sequence: 100 },
    { lineCode: "PL08-I-05", label: "Phụ lục III Mẫu 01 §I [05] — 8% purchases value (ND 174/2025 reduction schedule, filed with 01/GTGT)", sign: 1, sequence: 102 },
    { lineCode: "PL08-I-06", label: "Phụ lục III Mẫu 01 §I [06] — 8% purchase input tax", sign: 1, sequence: 104 },
    { lineCode: "PL08-II-07", label: "Phụ lục III Mẫu 01 §II [07] — 8% sales value", sign: 1, sequence: 106 },
    { lineCode: "PL08-II-08", label: "Phụ lục III Mẫu 01 §II [08] — 8% sales output tax", sign: -1, sequence: 108 },
    { lineCode: "PL08-III-09", label: "Phụ lục III Mẫu 01 §III [09]=[08]−[06] — 8% net", sign: 1, sequence: 110 },
    { lineCode: "OB_OUTPUT", label: "OpenBooks workpaper — output VAT from the ledger, all configured rates", sign: -1, sequence: 120, basis: "tax_collected", glMap: "sales" },
    { lineCode: "OB_INPUT", label: "OpenBooks workpaper — input VAT from the ledger, all configured rates", sign: 1, sequence: 130, basis: "tax_paid", glMap: "purchases" },
  ],
};

/**
 * Vietnam GTGT (value-added tax) localization. Currency is VND; the pack
 * carries no currency field. GTGT is national, so jurisdictions is empty:
 * the 01-2/01-3/01-6 allocation appendices share collected tax with
 * provinces but levy no subnational tax.
 *
 * The standard rate is 10% (Luật Thuế GTGT 48/2024/QH15, Điều 9 khoản 3,
 * in force 2025-07-01). The 10%, 5% and 0% bands run back to 2009-01-01 as
 * single open rows: Luật 13/2008/QH12, Điều 8 sets the same three values
 * (10% residual, 5% on clean water/fertiliser/farm goods, 0% on exports)
 * with effect from 01/01/2009, replacing the 1997 VAT law. These are
 * continuing-authority rows — the 2024 law is a recast with identical
 * values, and the intervening amendments (31/2013 on Điều 8 lists,
 * 71/2014, 106/2016) adjusted scopes and lists, not values — so equal
 * values collapse. The pre-2009 1997-law era is a named refusal (its rates
 * are unsourced from here). The 13/2008 text is read from the NA law as
 * republished on the Government trade portal (vietnamtradeportal.gov.vn):
 * the authority's own instrument mirrored on a .gov.vn host, with the
 * succession and amendment chain cross-checked primarily against the Law
 * 48/2024 repeal clause on Công báo (13/2008 as amended, repealed when Law
 * 48 takes effect). Earlier 8% windows are not transcribed here by order:
 * VN-VAT-RED8 below is untouched.
 *
 * Operative language (the mirror PDF carries the full enacted text, not a
 * summary — masthead QUỐC HỘI through Điều 16 with signatures — quoted so a
 * reader without the document can check it):
 * - Điều 8. Thuế suất: "Mức thuế suất 0% áp dụng đối với hàng hóa, dịch vụ
 *   xuất khẩu ..." / "Mức thuế suất 5% áp dụng đối với hàng hóa, dịch vụ
 *   sau đây: a) Nước sạch phục vụ sản xuất và sinh hoạt; ..." / "Mức thuế
 *   suất 10% áp dụng đối với hàng hóa, dịch vụ không quy định tại khoản 1
 *   và khoản 2 Điều này." (0% on exports; 5% on the listed goods starting
 *   with clean water; 10% residual on everything else.)
 * - Điều 15. Hiệu lực thi hành: "Luật này có hiệu lực thi hành từ ngày
 *   01 tháng 01 năm 2009." (in force from 01/01/2009), replacing the 1997
 *   VAT law.
 * - Law 48/2024, Điều 18.3 (Công báo): "Luật Thuế giá trị gia tăng số
 *   13/2008/QH12 đã được sửa đổi, bổ sung một số điều theo Luật số
 *   31/2013/QH13, Luật số 71/2014/QH13 và Luật số 106/2016/QH13 hết hiệu
 *   lực kể từ ngày Luật này có hiệu lực thi hành." (13/2008 as amended
 *   repealed when Law 48 takes effect, 01/07/2025 per Điều 18.1).
 *
 * The temporary 8% cut is its own code, VN-VAT-RED8: Nghị định
 * 174/2025/NĐ-CP (implementing Nghị quyết 204/2025/QH15) applies 8% from
 * 2025-07-01 through 2026-12-31 to goods and services otherwise at 10%,
 * EXCLUDING the Phụ lục I sectors (telecoms, finance/banking/securities,
 * insurance, real estate, metal products, mining except coal) and the
 * Phụ lục II special-consumption-tax goods (except petrol). Excluded
 * sectors stay on VN-VAT-STD at 10% — the 8% band is not the standard
 * rate right now. The band covers today and carries its published
 * effectiveTo; when it expires the schedule guard fails until the
 * successor rate is transcribed.
 *
 * 01/GTGT treatment of the 8% band (ND 174/2025, Điều 1, read from the
 * decree's Công báo text): 8% sales are invoiced with "8%" on the VAT-rate
 * line and the seller declares output / the buyer declares input per the
 * reduced amounts on the invoice (khoản 3a) — those amounts flow through
 * the 01/GTGT aggregates — AND every covered business files the reduction
 * schedule Phụ lục III Mẫu số 01 with the return (khoản 6): §I lists 8%
 * purchases (totals [05] value, [06] tax), §II lists 8% sales (totals [07]
 * value, [08] reduced tax), §III reports [09]=[08]−[06]. Those five totals
 * are the modelled boxes PL08-*, so the 8% band has a declared destination
 * on the return instead of landing only in the workpaper.
 *
 * Later amendments were read and change no headline rate: Luật
 * 90/2025/QH15 (Điều 9.1a export-goods definition), Luật 149/2025/QH15
 * (Điều 9.5 scrap rule, in force 2026-01-01), Luật 09/2026/QH16 (no VAT
 * rate change). Special consumption tax is a separate tax and is not
 * modelled. Thông tư 94/2025/TT-BTC amends Thông tư 80/2021/TT-BTC
 * without touching the 01/GTGT boxes.
 *
 * Filing is monthly; the form header also prints a quarterly period, but
 * the below-threshold quarterly election is an unmodelled election and is
 * named here rather than declared. Unmodelled boxes: [21] no activity,
 * [22] prior-period credit, [26] untaxed sales, [32a] non-declared sales,
 * [34]/[35] sales totals, [37]/[38] prior-period adjustments,
 * [39a] transferred credit, [40a]/[40b] payable computation, and the
 * [41]–[43] credit/refund pipeline.
 *
 * Reachability from this sandbox, 2026-09-18: www.gdt.gov.vn,
 * gdt.gov.vn, and dichvucong.gdt.gov.vn all time out (000 — the DNS
 * resolves but no connection is established, so this records that the
 * sandbox could not reach them, not that the hosts are gone); the e-tax
 * filing entry thuedientu.gdt.gov.vn answers (302 to /etaxnnt/), which
 * is what the portal filing channel is justified from. Rate and form
 * claims rest on the Government's own gazette (Công báo) files, not on
 * the tax portal. The NQ 204/2025/QH15 gazette PDF is a scanned
 * image-only page, so the window endpoints are read from the
 * implementing decree, which quotes the resolution.
 */
export const VIETNAM_TAX_PACK: CountryTaxPackDefinition = {
  code: "VN_INDIRECT_TAX",
  version: "2026.08.01",
  country: "VN",
  name: "Vietnam",
  countryTaxType: "vat",
  parentReturnPackCode: "VN_GTGT_01",
  completeness: {
    jurisdictions: "not_applicable",
    standardRates: "partial",
    returnDefinitions: "partial",
    localRates: "not_applicable",
    taxability: "partial",
    sourcingRules: "partial",
    nexusRules: "partial",
  },
  sources: [
    {
      id: "congbao_nd174_window",
      title: "Công báo 895+896 — Nghị định 174/2025/NĐ-CP: 8% window 2025-07-01 to 2026-12-31, exclusions, invoice treatment",
      url: "https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2025/6/45374/57334-1-2025895-896174-2025-nd-cp.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "congbao_nq204_mandate",
      title: "Công báo 849+850 — Nghị quyết 204/2025/QH15 enacting the VAT cut (catalogue record plus signed image-only PDF; operative window read from the implementing decree)",
      url: "https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2025/6/45219/57028-1-2025849-850204-2025-qh15.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "congbao_law48_rates",
      title: "Công báo 1527+1528 — Luật Thuế GTGT 48/2024/QH15, Điều 9: 0%/5%/10% bands, in force 2025-07-01; repeals Luật 13/2008/QH12 (as amended by 31/2013, 71/2014, 106/2016) on entry into force",
      url: "https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2024/11/43576/53720-1-20241527-152848-2024-qh15.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "tradeportal_law13_2008_rates",
      title: "Luật 13/2008/QH12 (3/6/2008), Điều 8: 0%/5%/10% bands in force from 01/01/2009 — NA law as republished on the Government trade portal (vietnamtradeportal.gov.vn); succession and amendment chain cross-checked primarily against the Law 48/2024 repeal clause on Công báo",
      url: "https://www.vietnamtradeportal.gov.vn/kcfinder/upload/files/13.2008.QH12.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "congbao_law90_export_def",
      title: "Công báo 907+908 — Luật 90/2025/QH15, Điều 4: amends the Điều 9.1a export-goods definition only; headline rates unchanged",
      url: "https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2025/6/45389/57364-1-2025907-90890-2025-qh15.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "congbao_law149_scrap_rule",
      title: "Công báo — Luật 149/2025/QH15: amends Điều 9.5 scrap rule only, in force 2026-01-01; headline rates unchanged",
      url: "https://congbaocdn.chinhphu.vn/180507251028987904/2026/1/26/149-17694169460221469064544.docx",
      asOf: "2026-09-18",
    },
    {
      id: "congbao_law09_2026_thresholds",
      title: "Công báo — Luật 09/2026/QH16: no VAT rate change; household-revenue threshold delegation only",
      url: "https://congbaocdn.chinhphu.vn/180507251028987904/2026/5/27/469536-1779329464_1779843285_signed.docx",
      asOf: "2026-09-18",
    },
    {
      id: "congbao_tt80_form01",
      title: "Công báo 969+970 — Thông tư 80/2021/TT-BTC, Phụ lục II: Mẫu 01/GTGT boxes [21]–[43]",
      url: "https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2021/9/34774/37499-1-2021969-97080-2021-tt-btc.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "congbao_tt94_forms_unchanged",
      title: "Công báo 1535+1536 — Thông tư 94/2025/TT-BTC: amends refund handling and ID fields; leaves the 01/GTGT boxes untouched",
      url: "https://congbaocdn.chinhphu.vn/CongBaoCP/VanBan/2025/10/46457/59475-1-20251535-153694-2025-tt-btc.pdf",
      asOf: "2026-09-18",
    },
    {
      id: "gdt_etax_portal",
      title: "General Department of Taxation e-tax filing entry (answers 302 to the e-tax application; content pages unreachable from this sandbox)",
      url: "https://thuedientu.gdt.gov.vn",
      asOf: "2026-09-18",
    },
  ],
  jurisdictions: [],
  returnPacks: [VN_GTGT_01],
  returnPackTaxCodes: {
    VN_GTGT_01: [
      {
        code: "VN-VAT-STD",
        name: "Vietnam standard GTGT 10%",
        ratePercent: 10,
        role: "standard",
        rates: [{ ratePercent: 10, effectiveFrom: "2009-01-01", sourceId: "tradeportal_law13_2008_rates" }],
      },
      {
        code: "VN-VAT-RED8",
        name: "Vietnam temporary reduced GTGT 8% (ND 174/2025, excludes Appendix I/II sectors)",
        ratePercent: 8,
        role: "reduced",
        rates: [{ ratePercent: 8, effectiveFrom: "2025-07-01", effectiveTo: "2026-12-31", sourceId: "congbao_nd174_window" }],
      },
      {
        code: "VN-VAT-RED5",
        name: "Vietnam reduced GTGT 5% — water, fertiliser, agricultural services and produce",
        ratePercent: 5,
        role: "reduced",
        rates: [{ ratePercent: 5, effectiveFrom: "2009-01-01", sourceId: "tradeportal_law13_2008_rates" }],
      },
      {
        code: "VN-VAT-ZERO",
        name: "Vietnam zero-rated GTGT 0% — exports",
        ratePercent: 0,
        role: "zero",
        rates: [{ ratePercent: 0, effectiveFrom: "2009-01-01", sourceId: "tradeportal_law13_2008_rates" }],
      },
    ],
  },
};
