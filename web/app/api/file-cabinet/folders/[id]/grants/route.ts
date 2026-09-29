import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { getGrants, postGrant } from "../../../grant-handlers";
const postBodySchema0 = z.object({
  principalType: z.string(),
  principalId: z.string(),
  access: z.string(),
});

export const runtime = "nodejs";

export const GET = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    return getGrants(gate, "folder", id);
  },
});

export const POST = defineRoute({
  public: "session",
  params: z.object({ id: z.string() }),
  body: postBodySchema0,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const { id } = await params;

    const body = routeBody;
    return postGrant(gate, "folder", id, body);
  },
});
