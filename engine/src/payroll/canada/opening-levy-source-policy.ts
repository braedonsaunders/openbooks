import { cmp, sum } from "../../money/money.ts";
import { PayrollError } from "../error.ts";
import type { PayrollCountryPack } from "../pack-types.ts";

type Policy = NonNullable<PayrollCountryPack["openingLevySource"]>;
const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const EHT_PROVINCES = ["BC", "MB", "NL", "ON"];
/** Complete original provincial opening evidence, including explicit zero allocations. */
export const CA_OPENING_LEVY_SOURCE: Policy = {
  programKeys: ["ca_wcb", "ca_eht", "ca_cnt"],
  validateScope(row) {
    if (row.federalAccountId !== null)
      throw new PayrollError(
        "Record the original federal EIN for each US allocation; Canadian allocations have no EIN",
      );
    if (row.subRegion || row.filingAccountId !== null) return false;
    if (row.programKey === "ca_wcb") return PROVINCES.includes(row.region);
    if (row.programKey === "ca_eht") return EHT_PROVINCES.includes(row.region);
    return row.programKey === "ca_cnt" && row.region === "QC";
  },
  validateRequired(rows) {
    if (rows.some((row) => !this.programKeys.includes(row.programKey)))
      throw new PayrollError("A Canadian opening cannot contain US levy allocations");
    for (const province of PROVINCES)
      if (!rows.some((row) => row.programKey === "ca_wcb" && row.region === province)) {
        throw new PayrollError(
          `Declare the original WCB/WSIB opening for ${province}, including zero when the source confirms none`,
        );
      }
    for (const province of EHT_PROVINCES)
      if (!rows.some((row) => row.programKey === "ca_eht" && row.region === province)) {
        throw new PayrollError(
          `Declare the original EHT opening for ${province}, including zero when the source confirms none`,
        );
      }
    if (!rows.some((row) => row.programKey === "ca_cnt" && row.region === "QC"))
      throw new PayrollError(
        "Declare the original Québec CNT opening, including zero when the source confirms none",
      );
  },
  async validateOpening({ opening, allocations }) {
    const wcb = sum(
      allocations.filter((row) => row.programKey === "ca_wcb").map((row) => row.amount),
    );
    const eht = sum(
      allocations.filter((row) => row.programKey === "ca_eht").map((row) => row.amount),
    );
    if (cmp(wcb, opening.wcbAssessableYtd) !== 0) {
      throw new PayrollError(
        "The province allocations must equal the original workers’ compensation assessable opening amount",
      );
    }
    if (cmp(eht, opening.ehtRemunerationYtd) !== 0) {
      throw new PayrollError(
        "The province allocations must equal the original EHT remuneration opening amount",
      );
    }
  },
};
