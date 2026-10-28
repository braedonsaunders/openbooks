import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { searchPreview } from "../../../../lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.strictObject({
  type: z.enum(["transaction", "contact", "account", "item", "project"]),
  id: z.string().regex(UUID, "id must be a record id that search issued"),
});

/**
 * POST { type, id } → the facts the header search shows beside a hit. The
 * record resolves through the same legs as a search under the reader's
 * current permissions and subsidiary scope; a record they cannot open has
 * no preview (404).
 */
export const POST = defineRoute({
  public: "session",
  body: bodySchema,
  handler: async ({ authz, body }) => {
    const preview = await searchPreview(authz, body);
    if (!preview) {
      return NextResponse.json(
        {
          error: "not_found",
          remedy: "the record is not one you can open; search again for records you can see",
        },
        { status: 404 },
      );
    }
    return NextResponse.json(preview, { headers: { "cache-control": "no-store" } });
  },
});
