import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

/** Download the immutable, hash-addressed audit binder frozen at publication. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid run id" }, { status: 400 });
  const gate = await guardPermission("close.read");
  if (gate instanceof NextResponse) return gate;
  const result = (await db.execute<{ binder_snapshot: unknown; binder_hash: string | null }>(sql`
    select binder_snapshot, binder_hash
      from close_runs
     where id = ${id} and org_id = ${gate.user.orgId} and status = 'published'
  `));
  const binder = result.rows[0];
  if (!binder?.binder_snapshot || !binder.binder_hash) {
    return NextResponse.json(
      { error: "published audit binder not found" },
      { status: 404 },
    );
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
        "Cache-Control": "private, immutable, max-age=31536000",
      },
    },
  );
}
