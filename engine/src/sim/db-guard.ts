import { env } from "../db.ts";

/**
 * Safety interlock. The harness provisions, mutates, and (on reset) wipes whole
 * orgs. It must NEVER run against a real tenant database. Two independent gates,
 * both required, and both fail closed:
 *
 *   1. OPENBOOKS_SIM=1 must be set in the environment.
 *   2. The database name must carry a `sim`/`test`/`sandbox` marker.
 *
 * A public user following the README points OPENBOOKS_DB_URL at the bundled
 * docker-compose Postgres (database `openbooks_sim`), which satisfies both.
 */

const NAME_MARKERS = ["sim", "test", "sandbox", "scratch"];

function databaseName(url: string): string {
  try {
    // pg URLs: postgres://user:pass@host:port/dbname?params
    const afterSlash = url.split("/").pop() ?? "";
    return afterSlash.split("?")[0]!.toLowerCase();
  } catch {
    return "";
  }
}

export function assertSimDatabase(): void {
  if (env.OPENBOOKS_SIM !== "1") {
    throw new Error(
      "refusing to run: set OPENBOOKS_SIM=1 to confirm this is a disposable simulation database " +
        "(the harness provisions and wipes whole orgs).",
    );
  }
  const url = env.OPENBOOKS_DB_URL ?? "";
  if (!url) throw new Error("OPENBOOKS_DB_URL is not set");
  const name = databaseName(url);
  if (!NAME_MARKERS.some((m) => name.includes(m))) {
    throw new Error(
      `refusing to run: database "${name}" does not look like a simulation database ` +
        `(name must contain one of: ${NAME_MARKERS.join(", ")}). ` +
        "Point OPENBOOKS_DB_URL at a throwaway DB such as openbooks_sim.",
    );
  }
}
