/** The named refusal every expense-amortization command and read raises. */
export type AmortizationErrorStatus = 403 | 404 | 409 | 422;

export class AmortizationError extends Error {
  readonly name = "AmortizationError";
  readonly status: AmortizationErrorStatus;
  readonly code: string;
  readonly remedy: string;

  constructor(
    message: string,
    options: {
      status?: AmortizationErrorStatus;
      code?: string;
      remedy?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.status = options.status ?? 422;
    this.code = options.code ?? "amortization_invalid";
    this.remedy = options.remedy ?? "Correct the amortization input and submit it again.";
  }
}

export const AMORTIZATION_FEATURE_KEY = "expenseAmortization";

export const AMORTIZATION_FEATURE_REMEDY =
  "Turn on Expense amortization in Company Settings → Features.";
