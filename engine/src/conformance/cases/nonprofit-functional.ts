import { splitSharedCost } from "../../nonprofit/functional.ts";
import type { CaseContext, ConformanceCase } from "../types.ts";

export const NONPROFIT_FUNCTIONAL_CASES: readonly ConformanceCase[] = [
  {
    id: "np-functional",
    title: "Shared costs follow a disclosed functional driver and tie to expense",
    citations: [{
      standard: "ASC 958",
      reference: "958-720",
      kind: "requirement",
      requirement: "Expenses are reported by their functional classification using a reasonable and consistently applied allocation basis for shared costs.",
    }],
    support: "supported",
    tier: "computation",
    assertion: "A disclosed allocation driver assigns each shared cost exactly once across functions, and the functional amounts equal the original expense.",
    facts: [
      "An organization allocates 101.00 of shared rent by occupied square footage.",
      "The program, management and general, and fundraising functions have driver weights of 50, 30, and 20.",
    ],
    expected: { values: { program: "50.5000", management_general: "30.3000", fundraising: "20.2000", total: "101.0000" } },
    run: (_ctx: CaseContext) => {
      const result = splitSharedCost({
        total: "101.00",
        targets: [
          { key: "program", functionKey: "program", weight: "50" },
          { key: "management", functionKey: "management_general", weight: "30" },
          { key: "fundraising", functionKey: "fundraising", weight: "20" },
        ],
        allocationRuleKey: "shared_occupancy",
        allocationRuleName: "Shared occupancy by square footage",
        driverKey: "occupied_area",
        driverName: "Occupied area",
        driverUnit: "square feet",
        asOf: "2026-09-27",
      });
      return {
        values: {
          ...result.functionTotals,
          total: result.targets.reduce((sum, target) => {
            const [whole = "0", fraction = ""] = target.amount.split(".");
            return sum + BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
          }, 0n).toString().replace(/(-?)(\d+)(\d{4})$/, "$1$2.$3"),
        },
      };
    },
  },
];
