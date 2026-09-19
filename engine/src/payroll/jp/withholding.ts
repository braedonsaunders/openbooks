/**
 * The JP pack's withholding jurisdictions: 源泉徴収 by prefecture of employment.
 *
 * Region codes are JIS X 0401 prefecture codes (see ./regions.ts): the
 * granularity the health-insurance rate varies at, and the granularity at
 * which the 特別徴収 municipality is determined (resident tax itself is
 * assigned, not computed — see JP_REFUSED_2026).
 *
 * All 47 are `implemented: true`, and that is the same fact as
 * `regions.supported` carrying all 47 (see ./pack.ts for why prefecture is
 * the axis and the tenant-declared rate the channel): the engine computes a
 * prefecture's withholding end to end once that prefecture's health rate is
 * known, and refuses the missing rate at the rate channel — never by
 * emptying `supported`.
 *
 * Non-residents are outside the 月額表 entirely: pay to a 非居住者 faces the
 * separate 20.42% withholding (所得税法第212条), which no pack engine
 * computes — hence `taxesNonresidentWages: false` everywhere below.
 */
import type {
  PayrollPackWithholding,
  PayrollRegionWithholding,
} from "../withholding-jurisdictions.ts";
import { JP_PREFECTURES } from "./regions.ts";

const JP_REGIONS: readonly PayrollRegionWithholding[] = JP_PREFECTURES.map(
  (prefecture): PayrollRegionWithholding => ({
    region: prefecture.code,
    label: `源泉徴収 (${prefecture.name})`,
    implemented: true,
    // Domestic employment income of a resident is subject to withholding at
    // source (所得税法第183条); the 月額表 prices it (同法第185条).
    taxesNonresidentWages: false,
    residentWithholding: "required",
    residentWithholdingImplemented: true,
    certificateKey: "jp_fuyo",
    subRegions: [],
    // Vacuous: no wage levy sits below the prefecture that this engine
    // prices (resident tax is municipality-assigned, refused by name), so no
    // comparison ever runs. Revisit if one is ever declared.
    subRegionConflictRule: "work_only",
    citation:
      "所得税法第183条（源泉徴収義務）、第185条（給与所得の源泉徴収税額表）; "
      + "NTA 令和8年分 給与所得の源泉徴収税額表（月額表）",
  }),
);

export const JP_WITHHOLDING: PayrollPackWithholding = {
  country: "JP",
  regions: JP_REGIONS,
};
