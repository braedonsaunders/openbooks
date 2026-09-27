import { PostingError } from "../journal/posting-contracts.ts";

export type NonprofitStatus = 409 | 422;

export interface NonprofitRefusalInput {
  message: string;
  status: NonprofitStatus;
  code: string;
  remedy: string;
  field?: string;
}

/** A typed refusal that route boundaries can safely return as a 4xx response. */
export class NonprofitError extends PostingError {
  readonly name: string = "NonprofitError";
  readonly status: NonprofitStatus;
  readonly code: string;
  readonly remedy: string;
  readonly field?: string;

  constructor(input: NonprofitRefusalInput) {
    super(input.message);
    this.status = input.status;
    this.code = input.code;
    this.remedy = input.remedy;
    if (input.field !== undefined) this.field = input.field;
  }
}

/** Posting-time refusals preserve the ledger's PostingError contract. */
export class NonprofitPostingError extends NonprofitError {
  readonly name: string = "NonprofitPostingError";
}

export const FUND_FEATURE_REMEDY = "Enable Fund Accounting in Company Settings → Features.";

export function fundFeatureOff(): NonprofitError {
  return new NonprofitError({
    message: `Fund Accounting is disabled; enable fundAccounting in Company Settings → Features.`,
    status: 422,
    code: "feature_off",
    remedy: FUND_FEATURE_REMEDY,
  });
}

export function fundPostingRefusal(input: Omit<NonprofitRefusalInput, "status"> & { status?: NonprofitStatus }): NonprofitPostingError {
  const { status = 422, ...rest } = input;
  return new NonprofitPostingError({ ...rest, status });
}
