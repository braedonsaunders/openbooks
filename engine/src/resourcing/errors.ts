export type ResourcingRefusalStatus = 409 | 422;

/** A typed operator-facing refusal from a resourcing service. */
export class ResourcingRefusal extends Error {
  readonly name = "ResourcingRefusal";

  constructor(
    readonly status: ResourcingRefusalStatus,
    readonly code: string,
    message: string,
    readonly remedy: string,
    readonly field?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
