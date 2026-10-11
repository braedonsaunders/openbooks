import { add } from "../../money/money.ts";
import type { PayrollAnnualMaximum } from "../pack-types.ts";
import { ratesForPayDate } from "./rates.ts";

/**
 * Canada's capped deductions and employer shares for the payslip
 * explanation (T4127/QPIP annual maximums). The maximums come from the
 * rates edition effective on the stub's pay date — the same edition that
 * priced the stub — so a later year's constants never reinterpret an old
 * payslip. A pay date with no published edition declares nothing: the
 * lines show no year-to-date rather than a guessed maximum.
 *
 * Pension shares carry the FULL annual maximum even though the engine
 * prorates the cap by months in the plan for mid-year joiners: the
 * year-to-date beside the line stays exact, and the "maximum reached"
 * note fires when the stored history reaches the published annual figure.
 * The employer EI share declares no maximum: it is the employee premium
 * times the employer's program multiple, which varies by payroll account,
 * so the employee line's own capped note tells that story.
 */
export function caAnnualMaximums(input: {
  taxYear: number;
  payDate: string;
  region: string;
}): readonly PayrollAnnualMaximum[] {
  let rates;
  try {
    rates = ratesForPayDate(input.payDate);
  } catch {
    return [];
  }
  const isQuebec = input.region === "QC";
  const plan = isQuebec ? rates.qpp : rates.cpp;
  const out: PayrollAnnualMaximum[] = [
    {
      systemKey: "cpp",
      kind: "deduction",
      ytdSources: [{ openingColumn: "cpp_ytd", factorKey: "C" }],
      maximum: plan.maxTotal,
      label: isQuebec ? "QPP contributions" : "CPP contributions",
    },
    {
      systemKey: "cpp2",
      kind: "deduction",
      ytdSources: [{ openingColumn: "cpp2_ytd", factorKey: "C2" }],
      maximum: plan.maxCpp2,
      label: isQuebec ? "QPP2 contributions" : "CPP2 contributions",
    },
    {
      systemKey: "ei",
      kind: "deduction",
      ytdSources: [{ openingColumn: "ei_ytd", factorKey: "EI" }],
      maximum: isQuebec ? rates.ei.qcMaxEmployee : rates.ei.maxEmployee,
      label: "EI premiums",
    },
    {
      systemKey: "cpp",
      kind: "employer_contribution",
      ytdSources: [
        { openingColumn: "employer_cpp_ytd", factorKey: "C" },
        { openingColumn: "employer_cpp2_ytd", factorKey: "C2" },
      ],
      maximum: add(plan.maxTotal, plan.maxCpp2),
      label: isQuebec ? "QPP contributions (employer)" : "CPP contributions (employer)",
    },
    {
      systemKey: "ei",
      kind: "employer_contribution",
      ytdSources: [{ openingColumn: "employer_ei_ytd", factorKey: "EI_ER" }],
      maximum: null,
      label: "EI premiums (employer)",
    },
  ];
  if (isQuebec) {
    out.push(
      {
        systemKey: "qpip",
        kind: "deduction",
        ytdSources: [{ openingColumn: "qpip_ytd", factorKey: "QPIP" }],
        maximum: rates.qpip.maxEmployee,
        label: "QPIP premiums",
      },
      {
        systemKey: "qpip",
        kind: "employer_contribution",
        ytdSources: [{ openingColumn: "qpip_employer_ytd", factorKey: "QPIP_ER" }],
        maximum: rates.qpip.maxEmployer,
        label: "QPIP premiums (employer)",
      },
    );
  }
  return out;
}
