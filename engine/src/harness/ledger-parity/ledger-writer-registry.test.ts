import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GL_MUTATION_SOURCE_FILES } from "./operations.ts";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(sourceRoot, "..", "..");
const mutationPattern =
  /insert\s+into\s+journal_(?:entries|lines)|update\s+journal_lines|\.insert\(schema\.journal(?:Entries|Lines)\)|\.update\(schema\.journalLines\)/i;

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "harness") out.push(...sourceFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

test("every production journal mutation source is explicitly registered", () => {
  let shippedFiles: Set<string> | null = null;
  try {
    shippedFiles = new Set(
      execFileSync("git", ["ls-files", "--", "engine/src"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean),
    );
  } catch {
    // Source archives have no Git metadata and contain only shipped files.
  }

  const discovered = sourceFiles(sourceRoot)
    .filter((path) =>
      shippedFiles ? shippedFiles.has(relative(repoRoot, path)) : true,
    )
    .filter((path) => mutationPattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(sourceRoot, path))
    .sort();
  assert.deepEqual(discovered, [...GL_MUTATION_SOURCE_FILES].sort());
});
