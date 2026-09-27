import { NextResponse } from "next/server";
import type { Authz } from "./authz";
import { notFound } from "@/lib/api/responses";

/**
 * Run.scope targets period locks, not the diagnostic/evidence population.
 * Fingerprints, readiness, reporting packages and reopen invalidation currently
 * span the organization. A selected subsidiary must never authorize that data.
 */

export function guardCloseScope(
  authz: Pick<Authz, "allowedSubsidiaryIds">,
): NextResponse | null {
  return authz.allowedSubsidiaryIds === null
    ? null
    : notFound("record");
}
