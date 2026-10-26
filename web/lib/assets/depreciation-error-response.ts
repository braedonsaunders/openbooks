import { NextResponse } from "next/server";
import {
  ClosedBatchError,
  DepreciationRefusalError,
  StalePreviewError,
} from "@openbooks/engine/assets/depreciation";
import { DepreciationFormulaError } from "@openbooks/engine/assets/depreciation-formula";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { unexpectedServerError } from "../api/unexpected";

/**
 * Map a thrown depreciation error to its real HTTP status.
 *
 * A domain refusal names the remedy and is the operator's to act on, so it
 * must reach them as a 4xx carrying that message — never as a 500 with an
 * internal string. Stale-preview and closed-period refusals keep their
 * structured bodies; the closed period is labelled in the viewer's `locale`.
 * Anything not typed as a domain refusal is an unexpected
 * fault: it is logged server-side and returned as a generic 500, so a driver
 * or invariant message is not disclosed to the caller.
 *
 * Shared by the run-depreciation route and its unit tests; kept out of the
 * route module because Next route files expose only their HTTP handlers.
 */
export function depreciationFailure(e: unknown, locale: string): NextResponse {
  if (e instanceof StalePreviewError) {
    return NextResponse.json({ error: "stale_preview" }, { status: 409 });
  }
  if (e instanceof ClosedBatchError) {
    return NextResponse.json(
      {
        error: "period_closed",
        asset: e.assetNumber,
        period: periodDisplayLabel(e.periodRef, locale),
      },
      { status: 409 },
    );
  }
  if (e instanceof DepreciationRefusalError) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
  if (e instanceof DepreciationFormulaError) {
    return NextResponse.json({ error: e.message }, { status: 422 });
  }
  return unexpectedServerError("assets/run-depreciation", e);
}
