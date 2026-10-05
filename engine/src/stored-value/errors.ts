import { PostingError } from "../journal/posting-contracts.ts";

export type StoredValueStatus = 409 | 422;

export interface StoredValueRefusalInput {
  message: string;
  status: StoredValueStatus;
  code: string;
  remedy: string;
  field?: string;
}

/** A typed refusal that route boundaries can safely return as a 4xx response. */
export class StoredValueError extends PostingError {
  readonly name: string = "StoredValueError";
  readonly status: StoredValueStatus;
  readonly code: string;
  readonly remedy: string;
  readonly field?: string;

  constructor(input: StoredValueRefusalInput) {
    super(input.message);
    this.status = input.status;
    this.code = input.code;
    this.remedy = input.remedy;
    if (input.field !== undefined) this.field = input.field;
  }
}

export const STORED_VALUE_FEATURE_REMEDY =
  "Enable Stored value in Company Settings → Features.";

export function storedValueFeatureOff(): StoredValueError {
  return new StoredValueError({
    message: "Stored value is disabled; enable storedValue in Company Settings → Features.",
    status: 422,
    code: "feature_off",
    remedy: STORED_VALUE_FEATURE_REMEDY,
  });
}

export function storedValueRefusal(
  input: Omit<StoredValueRefusalInput, "status"> & { status?: StoredValueStatus },
): StoredValueError {
  const { status = 422, ...rest } = input;
  return new StoredValueError({ ...rest, status });
}
