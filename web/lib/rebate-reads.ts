import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "./authz";
import { can } from "./authz";
import { subsidiaryVisibleFilter } from "./subsidiaries";

export type RebateReadView = "agreements" | "claims";

function sideVisibility(authz: Authz) {
  return sql`and ((a.side = 'customer' and ${can(authz, "ar.read")}) or (a.side = 'vendor' and ${can(authz, "ap.read")}))`;
}

export async function listRebateRecords(
  orgId: string,
  authz: Authz,
  view: RebateReadView,
  input: { status?: string; side?: "customer" | "vendor"; limit: number; offset: number },
) {
  const visibility = subsidiaryVisibleFilter(sql`a.subsidiary_id`, authz.allowedSubsidiaryIds);
  const sidePermission = sideVisibility(authz);
  const sideFilter = input.side ? sql`and a.side = ${input.side}` : sql``;
  const statusFilter = input.status
    ? sql`and ${view === "claims" ? sql`c.status` : sql`a.status`} = ${input.status}`
    : sql``;
  const from =
    view === "claims"
      ? sql`rebate_claims c join rebate_agreements a on a.org_id = c.org_id and a.id = c.agreement_id left join parties p on p.org_id = c.org_id and p.id = c.party_id`
      : sql`rebate_agreements a left join parties p on p.org_id = a.org_id and p.id = a.party_id`;
  const where = sql`where a.org_id = ${orgId} ${visibility} ${sidePermission} ${sideFilter} ${statusFilter}`;
  const count = (
    await db.execute<{ total: string }>(
      sql`select count(*)::text as total from ${from} ${where}`,
      "objects",
    )
  )[0];
  const rows = await db.execute(
    sql`
    select ${view === "claims" ? sql`c.*` : sql`a.*`},
           a.code as agreement_code, a.name as agreement_name, a.side,
           p.display_name as party_name
      from ${from} ${where}
     order by a.code, ${view === "claims" ? sql`c.created_at desc, c.id` : sql`a.id`}
     limit ${input.limit} offset ${input.offset}
  `,
    "objects",
  );
  return { rows, total: Number(count?.total ?? 0) };
}

export async function readRebateRecord(
  orgId: string,
  authz: Authz,
  view: RebateReadView,
  id: string,
) {
  const visibility = subsidiaryVisibleFilter(sql`a.subsidiary_id`, authz.allowedSubsidiaryIds);
  const sidePermission = sideVisibility(authz);
  const join =
    view === "claims"
      ? sql`join rebate_claims c on c.org_id = a.org_id and c.agreement_id = a.id`
      : sql``;
  const idColumn = view === "claims" ? sql`c.id` : sql`a.id`;
  const agreement = (
    await db.execute(
      sql`
    select a.*, a.code as agreement_code, a.name as agreement_name, a.side,
           p.display_name as party_name
      from rebate_agreements a ${join}
      left join parties p on p.org_id = a.org_id and p.id = a.party_id
     where a.org_id = ${orgId} and ${idColumn} = ${id}
       ${visibility} ${sidePermission}
  `,
      "objects",
    )
  )[0];
  if (!agreement) return null;
  const claim =
    view === "claims"
      ? ((
          await db.execute(
            sql`select * from rebate_claims where org_id = ${orgId} and id = ${id}`,
            "objects",
          )
        )[0] ?? null)
      : null;
  return { agreement, claim };
}
