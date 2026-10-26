import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  EmploymentReadError,
  listEmployablePeopleOptions,
  listEmployerSubsidiaryOptions,
  listEmploymentOptions,
  listHireablePeopleOptions,
  listLocationOptions,
  listPeopleOptions,
} from "@openbooks/engine/hrm/employment-read";
import { HrmPositionError } from "@openbooks/engine/hrm/positions";
import { listPositionOptions } from "@openbooks/engine/hrm/positions-read";
import {
  listLeaveFilingEmploymentOptions,
  listLeaveTypeOptions,
  listOwnLeaveEmploymentOptions,
} from "@openbooks/engine/hrm/leave-read";
import { HrmAuthorizationError } from "@openbooks/engine/hrm/authorization";
import { hrmAuthorizationResponse } from "@/lib/api/record-not-found";
import { db } from "@openbooks/engine/platform/db";
import { getAuthz } from "@/lib/authz";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { isUuid } from "@/lib/list-params";
/**
 * Authoring pickers for employment change requests. GET lists bounded,
 * org- and subsidiary-scoped option pages behind the HRM feature switch
 * and the read grant for the requested source (the same double gate as the
 * record route): `source=employments` names people holding an employment
 * for the line-manager picker, `source=locations` names active native
 * locations, `source=people` names the same holders keyed by party for the
 * exit-interviewer picker (the exit record names its interviewer by party),
 * `source=hireable-people` names active employee parties holding no
 * employment at all for the Hire drawer's person picker (the same
 * population the cockpit readiness panel counts),
 * `source=employable-people` names active person parties with no live
 * active employment, any role or none, for the New-employee form's
 * existing-person picker (a vendor, contractor, or partner gains the
 * role plus a first employment on the same party),
 * `source=employer-subsidiaries` names active legal entities for the
 * Hire drawer's employer picker,
 * `source=positions` names the funded establishment for the
 * position-assignment picker (behind hrm.position.read, never the
 * employment grant), and `source=leave-types` names active leave types for
 * the leave filing drawer (filers hold hrm.leave.request, so that source
 * admits the request grant where the employment sources require the read
 * grant). `source=leave-filing-employments` names the employments the
 * caller may file leave on behalf of for the drawer's manager filing mode
 * (managers hold hrm.leave.manage — the same grant plus employer scope the
 * filing gate enforces, never the employment read grant, so a line manager
 * without it can still reach the remedy). `source=leave-own-employments`
 * names the caller's own employments for self-service filing (filers hold
 * hrm.leave.request — the same ownership the filing gate enforces, so the
 * picker can never offer an employment the filing refusal would reject).
 * The drawer submits ids, never labels; unknown or out-of-scope ids stay
 * absent rather than leaking existence. GET carries no body, so no JSON
 * boundary parser runs here.
 */
const HRM_OPTION_SOURCES = [
  "employments",
  "locations",
  "positions",
  "people",
  "hireable-people",
  "employable-people",
  "employer-subsidiaries",
  "leave-types",
  "leave-filing-employments",
  "leave-own-employments",
] as const;

type HrmOptionSource = (typeof HRM_OPTION_SOURCES)[number];

const HRM_OPTION_SOURCE_ERROR =
  "source must be one of employments, locations, positions, people, hireable-people, employable-people, employer-subsidiaries, leave-types, leave-filing-employments, leave-own-employments";

function isHrmOptionSource(value: string | null): value is HrmOptionSource {
  return value !== null && (HRM_OPTION_SOURCES as readonly string[]).includes(value);
}

/**
 * One gate per source. An unknown source is a 400 before any grant, so a
 * caller learns the query contract without a permission probe. Leave types
 * admit either the read or the request grant; the read denial is the one
 * reported when neither is held.
 */
async function authorizeHrmOptions(request: Request) {
  const session = await getAuthz();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const source = new URL(request.url).searchParams.get("source");
  if (!isHrmOptionSource(source)) {
    return NextResponse.json({ error: HRM_OPTION_SOURCE_ERROR }, { status: 400 });
  }
  if (source === "leave-types") return guardLeaveOptions();
  if (source === "leave-filing-employments") {
    return guardFeaturePermission("hrm.leave.manage", "hrm");
  }
  if (source === "leave-own-employments") {
    return guardFeaturePermission("hrm.leave.request", "hrm");
  }
  return guardFeaturePermission(
    source === "positions" ? "hrm.position.read" : "hrm.employment.read",
    "hrm",
  );
}

export const GET = defineRoute({
  authorize: ({ request }) => authorizeHrmOptions(request),
  feature: "hrm",
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url);
    const source = url.searchParams.get("source");
    if (!isHrmOptionSource(source)) {
      return NextResponse.json({ error: HRM_OPTION_SOURCE_ERROR }, { status: 400 });
    }
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
      return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    const include = url.searchParams.get("include");
    if (include !== null && !isUuid(include)) {
      return NextResponse.json({ error: "include must be a uuid" }, { status: 400 });
    }
    const active = url.searchParams.get("active");
    if (active !== null && active !== "true" && active !== "false") {
      return NextResponse.json({ error: "active must be true or false" }, { status: 400 });
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
        return NextResponse.json({
          options: options.map((option) => ({
            id: option.employmentId,
            label: option.label,
          })),
        });
      }
      if (source === "leave-own-employments") {
        const options = await listOwnLeaveEmploymentOptions({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
        });
        return NextResponse.json({
          options: options.map((option) => ({
            id: option.employmentId,
            label: option.label,
          })),
        });
      }
      const options =
        source === "employments"
          ? await listEmploymentOptions(
              include === null
                ? { ...base, ...(active === null ? {} : { activeOnly: active === "true" }) }
                : {
                    ...base,
                    includeEmploymentId: include,
                    ...(active === null ? {} : { activeOnly: active === "true" }),
                  },
            )
          : source === "locations"
            ? await listLocationOptions(
                include === null ? base : { ...base, includeLocationId: include },
              )
            : source === "people"
              ? // Directory people with an employment, keyed by
                // party for the exit-interviewer picker — the same read
                // grant and subsidiary scope as the employment picker.
                await listPeopleOptions(
                  include === null
                    ? { ...base, ...(active === null ? {} : { activeOnly: active === "true" }) }
                    : {
                        ...base,
                        includePartyId: include,
                        ...(active === null ? {} : { activeOnly: active === "true" }),
                      },
                )
              : source === "hireable-people"
                ? // Employee parties with no employment at all, keyed by
                  // party for the Hire drawer's person picker — the same
                  // read grant and party-side scope as the people picker.
                  await listHireablePeopleOptions(
                    include === null ? base : { ...base, includePartyId: include },
                  )
                : source === "employable-people"
                  ? // Active people with no live active employment, any role
                    // or none, keyed by party for the New-employee form's
                    // existing-person picker — the same read grant and
                    // party-side scope as the hireable picker.
                    await listEmployablePeopleOptions(
                      include === null ? base : { ...base, includePartyId: include },
                    )
                  : source === "employer-subsidiaries"
                    ? // Active legal entities for the Hire drawer's employer
                      // picker — the employment read grant plus employer
                      // scope, so the drawer can never offer an entity the
                      // hire refusal would reject.
                      await listEmployerSubsidiaryOptions(
                        include === null ? base : { ...base, includeSubsidiaryId: include },
                      )
                    : await listPositionOptions(
                        include === null ? base : { ...base, includePositionId: include },
                      );
      return NextResponse.json({ options });
    } catch (e) {
      if (e instanceof HrmAuthorizationError) {
        return hrmAuthorizationResponse(e);
      }
      if (e instanceof EmploymentReadError || e instanceof HrmPositionError) {
        return apiErrorResponse(e, { safeStatus: 422 });
      }
      throw e;
    }
  },
});
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
