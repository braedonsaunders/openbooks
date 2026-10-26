import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import { signOwnDocument } from "@openbooks/engine/hrm/documents/documents";
import { guardPermission } from "@/lib/authz";
import { hrmDocumentsErrorResponse } from "../../_lib";
const signOwnBody = z.object({ name: z.string().trim().min(1).max(120) });
/**
 * POST /api/hrm/documents/[id]/sign — sign in-session: the actor's own
 * open signer row on their own document. Admits self-service logins
 * and HR readers alike; the service refuses when the actor holds no
 * open signer row here, so this path never signs for another person.
 */
export const POST = defineRoute({
  authorize: async () => {
    const self = await guardPermission("hrm.self.read");
    return self instanceof NextResponse ? await guardPermission("hrm.documents.read") : self;
  },
  feature: "hrmDocuments",
  params: z.object({ id: z.string() }),
  body: signOwnBody,
  handler: async ({ authz: actor, params, body }) => {
    try {
      const { id } = params;
      const document = await signOwnDocument({
        orgId: actor.user.orgId,
        actorId: actor.user.id,
        documentId: id,
        name: body.name,
      });
      return NextResponse.json({ document });
    } catch (e) {
      return hrmDocumentsErrorResponse(e);
    }
  },
});
