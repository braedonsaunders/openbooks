import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  mergeProjects,
  previewProjectMerge,
  ProjectMergeError,
} from "@openbooks/engine/src/projects/merge.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { guardProjectsFeature } from "../../../../lib/projects-gate";

export const runtime = "nodejs";

type Gate = Exclude<Awaited<ReturnType<typeof guardPermission>>, NextResponse>;

/** Both sides of a merge must sit inside the caller's subsidiary scope. */
async function guardMergeScope(
  gate: Gate,
  survivorId: string,
  duplicateId: string,
): Promise<NextResponse | null> {
  const rows = (await db.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from projects
     where org_id = ${gate.user.orgId} and id in (${survivorId}, ${duplicateId})`)).rows;
  if (rows.length !== 2) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  for (const row of rows) {
    const denied = guardSubsidiaryScope(gate, row.subsidiary_id);
    if (denied) return denied;
  }
  return null;
}

/** Preview the impact of merging one duplicate into its survivor. */
export async function GET(req: Request) {
  const gate = await guardPermission("projects.manage");
  if (gate instanceof NextResponse) return gate;
  const feature = await guardProjectsFeature(gate.user.orgId);
  if (feature) return feature;
  const url = new URL(req.url);
  const survivorId = url.searchParams.get("survivorId") ?? "";
  const duplicateId = url.searchParams.get("duplicateId") ?? "";
  if (!isUuid(survivorId) || !isUuid(duplicateId)) {
    return NextResponse.json(
      { error: "valid survivorId and duplicateId are required" },
      { status: 400 },
    );
  }
  const scope = await guardMergeScope(gate, survivorId, duplicateId);
  if (scope) return scope;
  try {
    // The route's scope pre-check above is a fast-path 404; the allowlist
    // travels into the locked merge too, so a mid-flight scope narrowing
    // still refuses before anything moves.
    return NextResponse.json(
      await previewProjectMerge(gate.user.orgId, survivorId, duplicateId, gate.allowedSubsidiaryIds),
    );
  } catch (error) {
    if (error instanceof ProjectMergeError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}

/** Merge the duplicate into the survivor in one transaction. */
export async function POST(req: Request) {
  const gate = await guardPermission("projects.manage");
  if (gate instanceof NextResponse) return gate;
  const feature = await guardProjectsFeature(gate.user.orgId);
  if (feature) return feature;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as Record<string, unknown>;
  const survivorId = typeof body.survivorId === "string" ? body.survivorId : "";
  const duplicateId = typeof body.duplicateId === "string" ? body.duplicateId : "";
  if (!isUuid(survivorId) || !isUuid(duplicateId)) {
    return NextResponse.json(
      { error: "valid survivorId and duplicateId are required" },
      { status: 400 },
    );
  }
  const scope = await guardMergeScope(gate, survivorId, duplicateId);
  if (scope) return scope;
  try {
    const result = await mergeProjects(gate.user.orgId, {
      survivorId,
      duplicateId,
      actorId: gate.user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ProjectMergeError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
