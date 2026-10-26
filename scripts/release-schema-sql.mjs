/**
 * The release schema as SQL text: the active baseline followed by every
 * forward migration in apply order. Static checks read this rather than a
 * migration directory, so they see the schema an installation actually has.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { releaseMigrationPlan } from "./migration-baseline-plan.mjs";

export function releaseSchemaFiles(root = process.cwd()) {
  const directory = join(root, "schema", "migrations");
  const generatedDirectory = join(directory, "generated");
  const generated = existsSync(generatedDirectory)
    ? readdirSync(generatedDirectory)
        .filter((file) => file.endsWith(".sql"))
        .sort()
    : [];
  return releaseMigrationPlan(directory, generated).filenames.map((filename) => ({
    filename,
    path: join(directory, filename),
  }));
}

export function releaseSchemaSql(root = process.cwd()) {
  return releaseSchemaFiles(root)
    .map(({ path }) => readFileSync(path, "utf8"))
    .join("\n");
}
