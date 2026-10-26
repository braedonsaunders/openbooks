import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import type { Authz } from "@/lib/authz";
import { guardCloseScope } from "@/lib/close-scope";
import { NextResponse } from "next/server";
import { readPublishedCloseBinder } from "@openbooks/engine/close/run-read";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

/** Download the immutable, hash-addressed audit binder frozen at publication. */
async function getPublishedBinder(id: string, gate: Authz) {
  if (!isUuid(id)) return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  const scopeDenied = guardCloseScope(gate);
  if (scopeDenied) return scopeDenied;
  const binder = await readPublishedCloseBinder(gate.user.orgId, id);
  if (!binder?.binder_snapshot || !binder.binder_hash) {
    return NextResponse.json({ error: "published audit binder not found" }, { status: 404 });
  }
  return new Response(
    JSON.stringify(
      {
        hashAlgorithm: "sha256",
        canonicalization: "openbooks.canonical-json.v1",
        hash: binder.binder_hash,
        binder: binder.binder_snapshot,
      },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="close-binder-${id}.json"`,
        "X-Content-SHA256": binder.binder_hash,
        "X-Content-Canonicalization": "openbooks.canonical-json.v1",
        "Cache-Control": "private, no-store",
      },
    },
  );
}

export const GET = defineRoute({
  permission: "close.read",
  feature: "continuousClose",
  params: z.object({ id: z.string() }),
  handler: async ({ params, authz }) => getPublishedBinder(params.id, authz),
});
