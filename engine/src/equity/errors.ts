/** The named refusal every equity command, read and model raises. */
export type EquityErrorStatus = 403 | 404 | 409 | 422;

export class EquityError extends Error {
  readonly name = "EquityError";
  readonly status: EquityErrorStatus;
  readonly code: string;
  readonly remedy: string;
  readonly field?: string;

  constructor(
    message: string,
    options: { status?: EquityErrorStatus; code?: string; remedy?: string; field?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.status = options.status ?? 422;
    this.code = options.code ?? "equity_invalid";
    this.remedy = options.remedy ?? "Correct the equity input and submit it again.";
    if (options.field !== undefined) this.field = options.field;
  }
}

export const EQUITY_FEATURE_KEY = "equity";

export const EQUITY_FEATURE_REMEDY = "Turn on Equity & cap table in Company Settings → Features.";

/** Where the effective-dated equity account policy is maintained. */
export const EQUITY_ACCOUNTS_REMEDY =
  "Add an equity account policy for the legal entity, effective on or before the transaction date (Setup → Equity accounts).";
