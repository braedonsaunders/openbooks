/** Forward migration files above the release baseline. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { migrationsDir } from "../bootstrap-paths";

export function generatedMigrationFiles(
  directory: string = join(migrationsDir, "generated"),
): string[] {
  const generated = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const seenOrdinals = new Map<number, string>();
  let previousOrdinal = -1;

  for (const file of generated) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
    if (!match) {
      throw new Error(`[bootstrap] generated migration ${file} does not have a four-digit ordinal`);
    }
    const ordinal = Number(match[1]);
    const duplicate = seenOrdinals.get(ordinal);
    if (duplicate) {
      throw new Error(
        `[bootstrap] generated migrations ${duplicate} and ${file} share ordinal ${match[1]}`,
      );
    }
    if (ordinal <= previousOrdinal) {
      throw new Error(
        `[bootstrap] generated migration ${file} is not in strictly increasing ordinal order`,
      );
    }
    seenOrdinals.set(ordinal, file);
    previousOrdinal = ordinal;
  }

  return generated;
}
