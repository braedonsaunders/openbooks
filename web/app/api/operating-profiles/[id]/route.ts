import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  OperatingProfileError,
  publishOperatingProfile,
} from "@openbooks/engine/organization/operating-profiles";
import { ProfileBody } from "../contract";
export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "The publishing command checks the profile work-family and capture features." },
  scope: "unrestricted",
  params: z.object({ id: uuidString() }).strict(),
  body: ProfileBody,
  handler: async ({ authz, body, params }) => {
    if (body.expectedVersion === undefined)
      throw new OperatingProfileError("Reload the workflow to obtain its current version.", 409);
    return withOrgTransaction(authz.user.orgId, async () =>
      NextResponse.json(
        await publishOperatingProfile(db, authz.user.orgId, authz.user.id, {
          ...body,
          id: params.id,
          expectedVersion: body.expectedVersion!,
        }),
      ),
    );
  },
});
