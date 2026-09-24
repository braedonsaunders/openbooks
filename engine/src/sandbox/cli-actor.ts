import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { assertUuid } from "./catalog.ts";

function flag(args: string[], name: string): string | undefined {
  const value = args.find((arg) => arg.startsWith(`--${name}=`));
  return value ? value.split("=").slice(1).join("=") : undefined;
}

/** Resolve the CLI actor to an existing user; unattributed change sets refuse. */
export async function resolveCliActor(args: string[]): Promise<string> {
  const actorId = flag(args, "actor");
  if (!actorId) {
    throw new Error("promote requires --actor <userId>: change sets must attribute their creator to a user");
  }
  try {
    assertUuid(actorId);
  } catch {
    throw new Error(`invalid actor ${actorId}: --actor must be a valid existing user id`);
  }
  const actor = (await db.execute<{ id: string }>(sql`select id from users where id = ${actorId}`)).rows[0];
  if (!actor) throw new Error(`unknown actor ${actorId}: --actor must be an existing user id`);
  return actor.id;
}
