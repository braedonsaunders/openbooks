import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * A ratchet only works while it bites. These numbers are set to the counts
 * measured on the day the ratchet was armed, and ci-pipeline-integrity.test.mjs
 * refuses a limit higher than what the tree really contains — so the next
 * person who wants headroom must fix code instead of editing a number.
 */
export const BASELINE_EXPLICIT_ANY = 2021;
export const MAX_EXPLICIT_ANY = 399;

const requireFromWeb = createRequire(new URL("../web/package.json", import.meta.url));
const ts = requireFromWeb("typescript");

export function measuredExplicitAnys() {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const counts = [];
  let total = 0;

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    let count = 0;
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) count += 1;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (count > 0) {
      counts.push({ count, file });
      total += count;
    }
  }

  counts.sort((left, right) => right.count - left.count || left.file.localeCompare(right.file));
  return { total, largestFiles: counts.slice(0, 20) };
}

function main() {
  const { total, largestFiles } = measuredExplicitAnys();

  if (total > MAX_EXPLICIT_ANY) {
    const leaders = largestFiles
      .map(({ count, file }) => `  ${String(count).padStart(4)}  ${file}`)
      .join("\n");
    console.error(
      `FAIL: ${total} explicit any type nodes exceed the ${MAX_EXPLICIT_ANY} limit.\n` +
        `Largest remaining files:\n${leaders}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `PASS: ${total} explicit any type nodes (limit ${MAX_EXPLICIT_ANY}; ` +
        `baseline ${BASELINE_EXPLICIT_ANY}, reduction ${BASELINE_EXPLICIT_ANY - total}).`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
