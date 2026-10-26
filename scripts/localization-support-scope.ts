import { execFileSync } from "node:child_process";
import { indirectTaxSupportScope } from "@openbooks/engine/country-tax-packs/support-scope";
import { payrollSupportScope } from "@openbooks/engine/payroll/support-scope";

const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      source: { gitSha, dirty },
      packs: payrollSupportScope(),
      indirectTax: indirectTaxSupportScope(),
    },
    null,
    2,
  ),
);
