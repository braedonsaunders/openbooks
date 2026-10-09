import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  ScopeNotFoundError,
  subsidiaryScopeAllows,
} from "../organization/subsidiary-scope.ts";
import { ManufacturingNotFoundError } from "./errors.ts";

/** A supplied scope is a narrowing filter, never a substitute for live authority. */
export async function lockManufacturingExecutionAuthority(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryId: string | null,
  requestedScope: ReadonlySet<string> | null,
): Promise<ReadonlySet<string> | null> {
  if (!subsidiaryId) throw new ManufacturingNotFoundError();
  const actor = (
    await tx.execute(
      sql`select id from users where id=${actorId} and is_active and (org_id=${orgId} or is_super_admin) for share`,
    )
  ).rows[0];
  if (!actor) throw new ManufacturingNotFoundError();
  let derived: ReadonlySet<string> | null;
  try {
    derived = await lockActorCommandAuthority(
      tx,
      orgId,
      actorId,
      subsidiaryId,
      "manufacturing.manage",
    );
    await lockActorCommandAuthority(
      tx,
      orgId,
      actorId,
      subsidiaryId,
      "items.post",
    );
  } catch (error) {
    if (error instanceof ScopeNotFoundError)
      throw new ManufacturingNotFoundError();
    throw error;
  }
  const scope =
    derived === null
      ? requestedScope
      : requestedScope === null
        ? derived
        : new Set([...derived].filter((id) => requestedScope.has(id)));
  if (!subsidiaryScopeAllows(scope, subsidiaryId))
    throw new ManufacturingNotFoundError();
  return scope;
}
