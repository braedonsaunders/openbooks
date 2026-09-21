/**
 * Construction-compliance refusals (HR-13). Every computed refusal is an
 * HrmConstructionError with a message that names the remedy — a refusal
 * that never reaches the caller is the defect this repository hunts.
 */
export class HrmConstructionError extends Error {}
