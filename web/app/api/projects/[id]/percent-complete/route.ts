import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
import { updateProjectPercentComplete } from "@/lib/project-percent-complete";

/**
 * PUT — set or clear the project's percent-complete OVERRIDE (0–100; null =
 * automatic cost-to-cost). Pure data entry: it refreshes the project's
 * revenue contract schedule, and the central recognition run posts the
 * catch-up. Nothing posts here.
 */
const percentCompleteBody = z
  .object({
    action: z.literal("set").default("set"),
    percentComplete: z.number().finite().nullable().optional(),
    expectedPercentComplete: z.number().finite().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "A percent-complete action is required.");

export const PUT = defineRoute({
  permission: "projects.manage",
  feature: "projects",
  params: z.object({ id: z.string() }),
  body: percentCompleteBody,
  handler: async ({ authz: gate, params: { id }, body }) => {
    if (!isUuid(id)) return notFound("record");

    const pct = body.percentComplete;
    if (
      pct !== null &&
      pct !== undefined &&
      (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100)
    ) {
      return NextResponse.json({ error: "percentComplete must be 0–100 or null" }, { status: 422 });
    }
    // An omitted percentComplete with a valid expected token would otherwise
    // fall through to the write below as undefined and persist a JSON null —
    // silently clearing an existing override and resyncing revenue on a value
    // nobody typed. Clearing is an explicit null with intent; a missing key is
    // a client contract error, refused before any read or write runs.
    if (!("percentComplete" in body) || pct === undefined) {
      return NextResponse.json(
        { error: "percentComplete is required; pass null to clear the override" },
        { status: 422 },
      );
    }
    // Mandatory compare-and-swap evidence on the single scalar being set: two
    // tabs saving absolute overrides must 409 instead of silently re-basing
    // revenue recognition on a stale number. The client sends the override
    // value it rendered (single-scalar variant of the revision-token contract —
    // no token plumbing, no false conflicts, exact intent preservation).
    // Checked after the gates so a missing value never leaks project existence.
    const expected = body.expectedPercentComplete;
    if (
      expected !== null &&
      expected !== undefined &&
      (typeof expected !== "number" || !Number.isFinite(expected) || expected < 0 || expected > 100)
    ) {
      return NextResponse.json(
        { error: "expectedPercentComplete must be 0–100 or null" },
        { status: 409 },
      );
    }
    if (expected === undefined) {
      return NextResponse.json(
        { error: "A current override value is required; reload the project and try again" },
        { status: 409 },
      );
    }

    const result = await updateProjectPercentComplete({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      projectId: id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      percentComplete: pct ?? null,
      expectedPercentComplete: expected ?? null,
    });
    if (result.kind === "feature_disabled") {
      return NextResponse.json({ error: "projects feature is disabled" }, { status: 404 });
    }
    if (result.kind === "revision_conflict") {
      return NextResponse.json(
        {
          error:
            "This override changed after you opened it; reload the project and reapply your value",
        },
        { status: 409 },
      );
    }
    if (result.kind === "not_found") return notFound("record");

    // The engine owns the Projects gate and names its skip: an override saved
    // while the sync is skipped must warn, never read back as applied progress.
    return NextResponse.json({
      ok: true,
      status: result.sync.synced[0] ?? null,
      problems: result.sync.skipped
        ? [...result.sync.problems, result.sync.skipped]
        : result.sync.problems,
    });
  },
});
