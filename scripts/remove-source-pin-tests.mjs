/**
 * Remove only `test`/`it` blocks flagged by sourcePinTests. Does not delete
 * module-level setup between tests (const arrays, helpers, for-loop wrappers).
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { sourcePinTests } from "./check-test-source-pins.mjs";

/** Line index after the last line of a test() / it() call. */
export function findTestEndLine(lines, start) {
  let braces = 0;
  let began = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "'" || ch === '"' || ch === "`") {
        const quote = ch;
        c++;
        while (c < line.length) {
          if (line[c] === "\\") {
            c += 2;
            continue;
          }
          if (line[c] === quote) break;
          c++;
        }
        continue;
      }
      if (ch === "/" && line[c + 1] === "/") break;
      if (ch === "/" && line[c + 1] !== "/" && line[c + 1] !== "*") {
        c += 2;
        while (c < line.length) {
          if (line[c] === "\\") {
            c += 2;
            continue;
          }
          if (line[c] === "/") break;
          c++;
        }
        continue;
      }
      if (ch === "{") {
        braces++;
        began = true;
      } else if (ch === "}") braces--;
    }
    const trimmed = line.trim();
    if (began && braces === 0 && /^\}\)\s*;?\s*$/.test(trimmed)) return i + 1;
    if (!began && i === start && /^\s*(?:test|it)\s*\([^)]*\)\s*;?\s*$/.test(line)) return i + 1;
  }
  throw new Error(`could not find end of test starting at line ${start + 1}`);
}

export function removePinTestsFromSource(source) {
  const lines = source.split("\n");
  const pinStarts = new Set(sourcePinTests(source).map((pin) => pin.line - 1));
  if (pinStarts.size === 0) return source;
  const testStarts = [];
  lines.forEach((line, index) => {
    if (/^\s*(?:test|it)\s*\(/.test(line)) testStarts.push(index);
  });
  const remove = new Set();
  for (const start of testStarts) {
    if (!pinStarts.has(start)) continue;
    const end = findTestEndLine(lines, start);
    for (let i = start; i < end; i++) remove.add(i);
  }
  const kept = lines.filter((_, i) => !remove.has(i));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

export function isEffectivelyEmpty(source) {
  const stripped = source.replace(/^\s*import[\s\S]*?;\s*/gm, "").replace(/^\s*\/\/.*$/gm, "").trim();
  return !/\btest\s*\(/.test(stripped) && !/\bit\s*\(/.test(stripped);
}

if (process.argv[1]?.endsWith("remove-source-pin-tests.mjs")) {
  const files = process.argv.slice(2);
  for (const file of files) {
    const before = readFileSync(file, "utf8");
    const after = removePinTestsFromSource(before);
    if (after === before) continue;
    if (isEffectivelyEmpty(after)) unlinkSync(file);
    else writeFileSync(file, after);
  }
}
