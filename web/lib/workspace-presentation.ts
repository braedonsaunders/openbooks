import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

/** Presentation defaults only; capabilities remain owned by Company Features. */
export const essentialsWorkspace = cache(async (orgId: string): Promise<boolean> => {
  const result = await db.execute<{ complexity: string | null }>(
    sql`
    select settings #>> '{workspaceProfile,complexity}' as complexity
      from orgs where id = ${orgId}
  `,
    "objects",
  );
  return result[0]?.complexity === "essentials";
});
