import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { NextResponse } from "next/server";
import { isUuid } from "./list-params";

export async function readLandedCostVouchers(
  orgId: string,
  allowedSubsidiaryIds: readonly string[] | null,
  input: {
    status: string | null;
    limit: string | null;
    search: string | null;
    cursor: string | null;
  },
): Promise<Response> {
  const status = input.status === null || input.status === "" ? null : input.status;
  if (status !== null && status !== "posted" && status !== "void") {
    return NextResponse.json({ error: "status must be posted or void" }, { status: 422 });
  }
  let limit = 50;
  if (input.limit !== null) {
    limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return NextResponse.json(
        { error: "limit must be an integer between 1 and 100" },
        { status: 422 },
      );
    }
  }
  const q = (input.search ?? "").trim();
  let cursor: { voucherDate: string; id: string } | null = null;
  if (input.cursor !== null && input.cursor !== "") {
    try {
      const parsed = JSON.parse(
        Buffer.from(input.cursor, "base64url").toString("utf8"),
      ) as Partial<{ voucherDate: unknown; id: unknown }>;
      if (
        typeof parsed?.voucherDate !== "string" ||
        typeof parsed?.id !== "string" ||
        !isUuid(parsed.id)
      ) {
        throw new Error("bad cursor");
      }
      cursor = { voucherDate: parsed.voucherDate, id: parsed.id };
    } catch {
      return NextResponse.json(
        { error: "page cursor is invalid — reload the list from the first page" },
        { status: 422 },
      );
    }
  }
  const scope =
    allowedSubsidiaryIds === null
      ? sql``
      : allowedSubsidiaryIds.length === 0
        ? sql`and false`
        : sql`and subsidiary_id in (${sql.join(
            allowedSubsidiaryIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
  const statusScope = status === null ? sql`` : sql`and status = ${status}`;
  const searchScope =
    q === ""
      ? sql``
      : sql`and (document_number ilike ${`%${q}%`} or coalesce(memo, '') ilike ${`%${q}%`})`;
  const cursorScope =
    cursor === null
      ? sql``
      : sql`and (voucher_date < ${cursor.voucherDate}::date
          or (voucher_date = ${cursor.voucherDate}::date and id > ${cursor.id}))`;
  const total = Number(
    (
      await db.execute<{ n: string }>(
        sql`
          select count(*)::text as n from landed_cost_vouchers
           where org_id = ${orgId} ${scope} ${statusScope} ${searchScope}`,
        "objects",
      )
    )[0]?.n ?? 0,
  );
  const rows = await db.execute(
    sql`
      select id, document_number as "documentNumber", status, amount, basis, voucher_date as "voucherDate", memo
        from landed_cost_vouchers where org_id = ${orgId}
       ${scope} ${statusScope} ${searchScope} ${cursorScope}
       order by voucher_date desc, id limit ${limit + 1}`,
    "objects",
  );
  const page = rows as Array<{ voucherDate: string; id: string } & Record<string, unknown>>;
  const hasMore = page.length > limit;
  const visible = hasMore ? page.slice(0, limit) : page;
  const last = visible[visible.length - 1];
  return NextResponse.json({
    vouchers: visible,
    totalCount: total,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ voucherDate: last.voucherDate, id: last.id }),
            "utf8",
          ).toString("base64url")
        : null,
  });
}
