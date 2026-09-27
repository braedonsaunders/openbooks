import { NextResponse } from "next/server";
import { findDuplicateProjects } from "@openbooks/engine/src/projects/merge.ts";
import { defineRoute } from '@/lib/api/route'

/** List duplicate-project groups (same source ref, name+customer, job number). */
export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projects',
  handler: async ({ authz }) => {
  const groups = await findDuplicateProjects(authz.user.orgId, {
    subsidiaryIds: authz.allowedSubsidiaryIds === null
      ? null
      : [...authz.allowedSubsidiaryIds],
  });
  return NextResponse.json({ groups });
  },
})
