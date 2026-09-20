/**
 * Recruiting refusal codes (HR-6, 0195). Every computed refusal is raised
 * with its remedy in the message — never swallowed, never a bare status.
 */
export type RecruitingErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "BAD_STATE"
  | "STALE_REVISION"
  | "REFUSED";

export class RecruitingError extends Error {
  readonly code: RecruitingErrorCode;
  constructor(code: RecruitingErrorCode, message: string) {
    super(message);
    this.name = "RecruitingError";
    this.code = code;
  }
}
