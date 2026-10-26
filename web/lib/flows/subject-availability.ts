import "server-only";
import { NextResponse } from "next/server";
import {
  FlowSubjectFeatureDisabledError,
  flowSubjectAvailable,
} from "@openbooks/engine/flows/module";
import { resolvedFeatureState } from "../features";
import type { ApiErrorBody } from "../api/responses";

/**
 * Subject kinds an organization can author new flows over: each kind's
 * owning features (and their parents and prerequisites) must be enabled on
 * Company Settings → Features. Existing flows on a kind whose feature was
 * later switched off stay listed and readable; only new authoring is
 * withheld.
 */
export async function isFlowSubjectAvailable(orgId: string): Promise<(kind: string) => boolean> {
  const state = await resolvedFeatureState(orgId);
  return (kind) => flowSubjectAvailable(state, kind);
}

/**
 * The refusal a flow writer answers when the subject's owning feature is
 * off. `details.feature` names the switch so the client can render the
 * feature's localized title and point to the switchboard.
 */
export function flowSubjectFeatureRefusal(error: unknown): NextResponse | null {
  if (!(error instanceof FlowSubjectFeatureDisabledError)) return null;
  const body: ApiErrorBody = {
    error: error.message,
    code: error.code,
    remedy: error.feature
      ? "Turn the feature on in Company Settings → Features, then create the flow again."
      : "Choose a record type from the list.",
    details: { subjectKind: error.subjectKind, feature: error.feature },
  };
  return NextResponse.json(body, { status: 422 });
}
