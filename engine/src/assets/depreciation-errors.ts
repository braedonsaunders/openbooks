/** Depreciation refusal error and postable-status gate. Split from assets/depreciation.ts (ARCH-FILE-SPLIT; pure moves only). */

/**
 * An operator-facing depreciation refusal: a missing or invalid asset/book/
 * period/category configuration, or an input the operator can correct. The
 * message names the remedy. Boundary routes map it to a 4xx with that message
 * instead of collapsing it into a 500; internal invariants (an out-of-balance
 * preview, a claim that recorded no line) stay plain Error and remain 500.
 */
export class DepreciationRefusalError extends Error {
  readonly name = "DepreciationRefusalError";
}

/**
 * The ONE status gate for postable depreciation schedules. Only an asset
 * placed in service — in_service or fully_depreciated — owns schedule lines
 * the preview/run/confirm path may GL-post. Exhaustive by construction:
 * draft, disposed, written_off, or any unknown status refuses by name, so a
 * draft's formula lines can never leak into a posting run (the input path
 * already requires in_service; this keeps every other path consistent).
 * Every schedule query below that scopes to postable assets uses exactly this
 * set — grep POSTABLE_DEPRECIATION_STATUSES before adding another.
 */
export const POSTABLE_DEPRECIATION_STATUSES = ["in_service", "fully_depreciated"] as const;

export function assertPostableDepreciationStatus(status: string, assetNumber: string): void {
  if (
    status !== "in_service" &&
    status !== "fully_depreciated"
  ) {
    throw new DepreciationRefusalError(
      `asset ${assetNumber} must be in service before depreciation can be scheduled or posted (status: ${status}) — place it in service first`,
    );
  }
}
