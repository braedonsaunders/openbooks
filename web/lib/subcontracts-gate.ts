import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

async function enabled(orgId: string): Promise<boolean> {
  const result = (await db.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'projects')::boolean, true)
       and coalesce((settings->'features'->>'subcontracts')::boolean, false) as enabled
      from orgs where id = ${orgId}
  `));
  return result.rows[0]?.enabled === true;
}

export async function requireSubcontractsFeature(orgId: string): Promise<void> {
  if (!(await enabled(orgId))) redirect("/admin/setup/features");
}

export async function guardSubcontractsFeature(orgId: string): Promise<NextResponse | null> {
  if (await enabled(orgId)) return null;
  return NextResponse.json({ error: "subcontracts feature is disabled" }, { status: 404 });
}

