import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import type { Authz } from "@/lib/authz";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { inTypeAudience, loadRecordTypeByKey } from "@/lib/records";
import { clamp } from "@/lib/list-params";
import { pgTextArrayLiteral } from "@/lib/pg-array";
import { lintRecordFields } from "@/lib/record-schema";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Records of one type: `?q=` searches the precomputed search text +
 * record number, `?status=` filters, `?page=/&perPage=` paginate.
 */
async function legacyGET(
  req: Request,
  { params }: { params: Promise<{ typeKey: string }> },
  gate: Authz,
) {
  const { user } = gate;
  const { typeKey } = await params;

  const type = await loadRecordTypeByKey(user.orgId, typeKey);
  if (
    !type ||
    type.status !== "published" ||
    !inTypeAudience(
      user.roles.map(({ key }) => key),
      type.allowed_roles,
    )
  ) {
    return notFound("record");
  }
  const lint = lintRecordFields(type.fields, type.name);
  const hasSubsidiaryField =
    lint.success &&
    lint.sections.some((section) => section.fields.some((field) => field.id === "subsidiary_id"));

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const status = url.searchParams.get("status");
  const page = clamp(Number(url.searchParams.get("page") ?? "1"), 1, 10_000);
  const perPage = clamp(Number(url.searchParams.get("perPage") ?? "25"), 5, 100);

  const fence = gate.allowedSubsidiaryIds;
  const where = sql`r.org_id = ${user.orgId} and r.type_key = ${typeKey}
    ${
      fence === null
        ? sql``
        : sql` and (
          r.data ->> ${"subsidiary_id"} = any(${pgTextArrayLiteral([...fence])}::text[])
          ${hasSubsidiaryField ? sql`` : sql` or r.data ->> ${"subsidiary_id"} is null`}
        )`
    }
    ${status ? sql` and r.status = ${status}` : sql``}
    ${q ? sql` and (r.search_text ilike ${"%" + q.toLowerCase() + "%"} or r.record_number ilike ${"%" + q + "%"})` : sql``}`;

  const [rows, count] = await Promise.all([
    db.execute(
      sql`
      select r.id, r.record_number, r.data, r.status, r.created_at, r.updated_at
        from custom_records r
       where ${where}
       order by r.created_at desc
       limit ${perPage} offset ${(page - 1) * perPage}
    `,
      "objects",
    ),
    db.execute<{ n: string }>(
      sql`select count(*) as n from custom_records r where ${where}`,
      "objects",
    ),
  ]);

  return NextResponse.json({
    records: rows,
    total: Number(count[0]?.n ?? 0),
    page,
    perPage,
  });
}

export const GET = defineRoute({
  permission: "records.read",
  feature: {
    none: "Custom record access is resolved from the selected type and caller's role; the registry has no organization feature switch.",
  },
  params: z.object({ typeKey: z.string() }),
  handler: async ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});
