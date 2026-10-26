import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sodBlockedIds } from "./sod.ts";
import type { FlowSubjectContext } from "./types.ts";

/** A person's second login cannot evade the tenant's self-approval restriction. */
export async function resolveSodBlockedIds(
  orgId: string,
  subject: FlowSubjectContext | null,
  additional: readonly string[] = [],
): Promise<ReadonlySet<string>> {
  const blocked = new Set([...sodBlockedIds(subject), ...additional]);
  if (blocked.size === 0) return blocked;
  const aliases = await db.execute<{
    id: string;
  }>(
    sql`select distinct u.id from users u join users maker
  on maker.org_id=u.org_id and maker.party_id=u.party_id and maker.party_id is not null
  where u.org_id=${orgId} and maker.id in(select jsonb_array_elements_text(${JSON.stringify([...blocked])}::jsonb)::uuid)`,
    "objects",
  );
  for (const alias of aliases) blocked.add(alias.id);
  return blocked;
}
