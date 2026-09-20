import { NextResponse } from "next/server";
import { findDuplicateProjects } from "@openbooks/engine/src/projects/merge.ts";
import { guardPermission } from "../../../../lib/authz";
import { guardProjectsFeature } from "../../../../lib/projects-gate";

export const runtime = "nodejs";

/** List duplicate-project groups (same source ref, name+customer, job number). */
export async function GET() {
  const gate = await guardPermission("projects.read");
  if (gate instanceof NextResponse) return gate;
  const feature = await guardProjectsFeature(gate.user.orgId);
  if (feature) return feature;
  const groups = await findDuplicateProjects(gate.user.orgId, {
    subsidiaryIds: gate.allowedSubsidiaryIds === null
      ? null
      : [...gate.allowedSubsidiaryIds],
  });
  return NextResponse.json({ groups });
}
