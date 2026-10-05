import { PayrollError } from "./error.ts";

/** Authoring patterns produce the same bounded formula language; there is no alternative calculator. */
export function compensationPackagePattern(input: { pattern: "fixed" | "hourly" | "percentage" | "conditional"; amountInput: string; factorInput?: string; conditionInput?: string }): string {
  for (const name of [input.amountInput, input.factorInput, input.conditionInput]) if (name !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new PayrollError("A package pattern needs declared input names — choose its inputs before constructing the expression.");
  switch (input.pattern) {
    case "fixed": return input.amountInput;
    case "hourly":
    case "percentage": if (!input.factorInput) throw new PayrollError("This package pattern needs a factor input — select hours or a scalar percentage."); return `${input.amountInput} * ${input.factorInput}${input.pattern === "percentage" ? " / 100" : ""}`;
    case "conditional": if (!input.conditionInput) throw new PayrollError("The conditional pattern needs a boolean input — select its condition."); return `if(${input.conditionInput}, ${input.amountInput}, 0)`;
    default: throw new PayrollError("Choose a supported compensation package pattern.");
  }
}
