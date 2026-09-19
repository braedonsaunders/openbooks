import { NextResponse } from "next/server";
import {
  EmploymentReadError,
  listEmploymentOptions,
  listLocationOptions,
} from "@openbooks/engine/src/hrm/employment-read.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Authoring pickers for employment change requests. GET lists bounded,
 * org- and subsidiary-scoped option pages behind the HRM feature switch
 * and the employment read grant (the same double gate as the record
 * route): `source=employments` names people holding an employment for the
 * line-manager picker, `source=locations` names active native locations.
 * The drawer submits ids, never labels; unknown or out-of-scope ids stay
 * absent rather than leaking existence. GET carries no body, so no JSON
 * boundary parser runs here.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission("hrm.employment.read", "hrm");
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  if (source !== "employments" && source !== "locations") {
    return NextResponse.json({ error: "source must be one of employments, locations" }, { status: 400 });
  }
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
    return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
  }
  const include = url.searchParams.get("include");
  if (include !== null && !isUuid(include)) {
    return NextResponse.json({ error: "include must be a uuid" }, { status: 400 });
  }
  const base = {
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    q: url.searchParams.get("q") ?? undefined,
    ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
  };
  try {
    const options =
      source === "employments"
        ? await listEmploymentOptions(
            include === null ? base : { ...base, includeEmploymentId: include },
          )
        : await listLocationOptions(
            include === null ? base : { ...base, includeLocationId: include },
          );
    return NextResponse.json({ options });
  } catch (e) {
    if (e instanceof HrmAuthorizationError) {
      return NextResponse.json({ error: (e as Error).message }, { status: 403 });
    }
    if (e instanceof EmploymentReadError) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 });
    }
    throw e;
  }
}
