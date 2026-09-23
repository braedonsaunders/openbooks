import { NextResponse } from "next/server";
import {
  EmploymentReadError,
  listEmploymentOptions,
  listLocationOptions,
} from "@openbooks/engine/src/hrm/employment-read.ts";
import { HrmPositionError } from "@openbooks/engine/src/hrm/positions.ts";
import { listPositionOptions } from "@openbooks/engine/src/hrm/positions-read.ts";
import { listLeaveFilingEmploymentOptions, listLeaveTypeOptions } from "@openbooks/engine/src/hrm/leave-read.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
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
 * employment grant), and `source=leave-types` names active leave types for
 * the leave filing drawer (filers hold hrm.leave.request, so that source
 * admits the request grant where the employment sources require the read
 * grant). `source=leave-filing-employments` names the employments the
 * caller may file leave on behalf of for the drawer's manager filing mode
 * (managers hold hrm.leave.manage — the same grant plus employer scope the
 * filing gate enforces, never the employment read grant, so a line manager
 * without it can still reach the remedy). The drawer submits ids, never
 * labels; unknown or out-of-scope ids stay absent rather than leaking
 * existence. GET carries no body, so no JSON boundary parser runs here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  if (
    source !== "employments" &&
    source !== "locations" &&
    source !== "positions" &&
    source !== "leave-types" &&
    source !== "leave-filing-employments"
  ) {
    return NextResponse.json(
      { error: "source must be one of employments, locations, positions, leave-types, leave-filing-employments" },
      { status: 400 },
    );
  }
  // One gate per source: the establishment behind its own read grant, leave
  // types behind the request grant (the filer's), the on-behalf employment
  // picker behind the manage grant (the manager's), everything else behind
  // the employment read grant.
  const gate =
    source === "leave-types"
      ? await guardLeaveOptions()
      : source === "leave-filing-employments"
        ? await guardFeaturePermission("hrm.leave.manage", "hrm")
        : await guardFeaturePermission(source === "positions" ? "hrm.position.read" : "hrm.employment.read", "hrm");
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
    if (source === "leave-types") {
      const options = await listLeaveTypeOptions(db, gate.user.orgId);
      return NextResponse.json({ options });
    }
    if (source === "leave-filing-employments") {
      // The drawer parses {id, label} uniformly, so the employment options
      // are projected onto that shape here — the engine keeps its own
      // employmentId key for its other picker consumers.
      const options = await listLeaveFilingEmploymentOptions(
        include === null ? base : { ...base, includeEmploymentId: include },
      );
      return NextResponse.json({ options: options.map((option) => ({ id: option.employmentId, label: option.label })) });
    }
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

/**
 * Leave-type options admit either grant: managers read the taxonomy, filers
 * need it to file. The read denial reports when neither grant is held.
 */
async function guardLeaveOptions() {
  const read = await guardFeaturePermission("hrm.leave.read", "hrm");
  if (!(read instanceof NextResponse)) return read;
  const request = await guardFeaturePermission("hrm.leave.request", "hrm");
  if (!(request instanceof NextResponse)) return request;
  return read;
}
