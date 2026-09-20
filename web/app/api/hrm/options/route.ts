import { NextResponse } from "next/server";
import {
  EmploymentReadError,
  listEmploymentOptions,
  listLocationOptions,
} from "@openbooks/engine/src/hrm/employment-read.ts";
import { HrmPositionError } from "@openbooks/engine/src/hrm/positions.ts";
import { listPositionOptions } from "@openbooks/engine/src/hrm/positions-read.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Authoring pickers for employment change requests. GET lists bounded,
 * org- and subsidiary-scoped option pages behind the HRM feature switch
 * and the read grant for the requested source (the same double gate as the
 * record route): `source=employments` names people holding an employment
 * for the line-manager picker, `source=locations` names active native
 * locations, `source=positions` names the funded establishment for the
 * position-assignment picker (behind hrm.position.read, never the
 * employment grant). The drawer submits ids, never labels; unknown or
 * out-of-scope ids stay absent rather than leaking existence. GET carries
 * no body, so no JSON boundary parser runs here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  if (source !== "employments" && source !== "locations" && source !== "positions") {
    return NextResponse.json({ error: "source must be one of employments, locations, positions" }, { status: 400 });
  }
  const gate = await guardFeaturePermission(
    source === "positions" ? "hrm.position.read" : "hrm.employment.read",
    "hrm",
  );
  if (gate instanceof NextResponse) return gate;
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
        : source === "locations"
          ? await listLocationOptions(
              include === null ? base : { ...base, includeLocationId: include },
            )
          : await listPositionOptions(
              include === null ? base : { ...base, includePositionId: include },
            );
    return NextResponse.json({ options });
  } catch (e) {
    if (e instanceof HrmAuthorizationError) {
      return NextResponse.json({ error: (e as Error).message }, { status: 403 });
    }
    if (e instanceof EmploymentReadError || e instanceof HrmPositionError) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 });
    }
    throw e;
  }
}
