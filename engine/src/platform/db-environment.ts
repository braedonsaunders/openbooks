import { readsLocalEnvFile } from "./runtime-database-role.ts";
import { parseEnv } from "node:util";

/** Resolve DB-module configuration without importing local service credentials
 * into a test process. The file reader is lazy so tests never open the file.
 *
 * The repo .env file holds developer-local endpoints and is read ONLY when
 * the operator explicitly named the development runtime. An unset NODE_ENV —
 * the state every hand-run maintenance script is in — is unknown, not
 * local: failing closed here keeps such a script from silently inheriting
 * dev database configuration and pointing at the wrong database. Name
 * NODE_ENV=development (or export the endpoints) to opt into the file.
 */
export function resolveDatabaseEnvironment(
  processEnvironment: Record<string, string | undefined>,
  readLocalFile: () => string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (readsLocalEnvFile(processEnvironment.NODE_ENV) && !processEnvironment.NODE_TEST_CONTEXT) {
    try {
      for (const [key, value] of Object.entries(parseEnv(readLocalFile()))) {
        if (typeof value === "string" && /^[A-Z0-9_]+$/.test(key)) resolved[key] = value;
      }
    } catch {
      // Containers have no local file and supply their environment explicitly.
    }
  }
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (value !== undefined && /^[A-Z0-9_]+$/.test(key)) resolved[key] = value;
  }
  return resolved;
}
