import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["web/app/api", "engine/src/hrm"];
const bareDate = /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//g;
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(file);
      continue;
    }
    if (!entry.isFile() || !file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    if (directory.startsWith("web/app/api") && !file.endsWith("/bodies.ts")) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(bareDate)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${file}:${line}: use the shared calendar-valid civil-date parser`);
    }
  }
}

for (const root of roots) await visit(root);
if (violations.length) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("No shape-only civil-date validation in API body schemas or HRM engine services.\n");
}
