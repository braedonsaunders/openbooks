/**
 * Qualification refusals (HR-14). Every computed refusal is an
 * HrmQualificationError with a message that names the remedy — a refusal
 * that never reaches the caller is the defect this repository hunts.
 */
export class HrmQualificationError extends Error {}
