import { PostingError } from "../journal/posting-contracts.ts";

export class ManufacturingPostingError extends PostingError {
  constructor(message: string) {
    super(message);
    this.name = "ManufacturingPostingError";
  }
}

export interface ManufacturingErrorOptions {
  status?: number;
  code: string;
  remedy?: string;
  field?: string;
}

export class ManufacturingError extends Error {
  readonly status: number;
  readonly code: string;
  readonly remedy?: string;
  readonly field?: string;

  constructor(message: string, { status = 422, code, remedy, field }: ManufacturingErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.remedy = remedy;
    this.field = field;
  }
}

export class ManufacturingNotFoundError extends ManufacturingError {
  constructor() {
    super("not_found", { status: 404, code: "not_found" });
  }
}

export class ManufacturingIdempotencyConflictError extends ManufacturingError {
  constructor() {
    super("idempotency_key_conflict", { status: 409, code: "idempotency_key_conflict" });
  }
}

export class ManufacturingFeatureDisabledError extends ManufacturingError {
  constructor(feature: string) {
    super(`${feature} is disabled. Turn it on in Company Settings → Features.`, {
      status: 404,
      code: "not_found",
    });
  }
}
