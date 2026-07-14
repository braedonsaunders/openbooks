import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@openbooks/schema";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(repoRoot, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

export const env = loadEnv();
export const pool = new pg.Pool({ connectionString: env.OPENBOOKS_DB_URL, max: 10, keepAlive: true });
// A transient network blackout (e.g. the WG path to the DB VIP dropping) makes
// an idle pool client emit 'error'; with no listener, Node crashes the whole
// process — fatal for long-running jobs. Swallow it: the pool reconnects on the
// next query, and per-query failures still reject normally (callers catch them).
pool.on("error", (err) => {
  console.error("[pg pool] transient client error (ignored, will reconnect):", (err as Error).message);
});
export const db = drizzle(pool, { schema });
export { schema };
