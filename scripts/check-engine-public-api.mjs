/** All external engine consumers use explicit package contracts. No source-path exemptions. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importsOf } from "./engine-imports.mjs";

const root = resolve(import.meta.dirname, "..");
const prefix = "@openbooks/engine";
const testConsumer =
  /\.(?:test|spec|child)\.[cm]?[jt]sx?$|\/(?:testing|tests?|fixtures)\/|^e2e\/|^scripts\/(?:verify-|test-)/;

export function contractViolations(file, text, exports, repo = root) {
  const problems = [];
  for (const { spec, line, computed } of importsOf(file, text)) {
    const location = `${file}:${line}`;
    if (computed) {
      problems.push(`${location}: computed engine import; select an explicit package contract`);
      continue;
    }
    if (spec === prefix || spec.startsWith(`${prefix}/`)) {
      const key = `.${spec.slice(prefix.length)}`;
      if (key === "./src" || key.startsWith("./src/") || !Object.hasOwn(exports, key)) {
        problems.push(`${location}: ${spec}; use an explicit @openbooks/engine package contract`);
      } else if (key.startsWith("./testing/") && !testConsumer.test(file)) {
        problems.push(`${location}: ${spec}; test support is not an application contract`);
      }
      continue;
    }
    let target;
    if (spec.startsWith("file:")) {
      try {
        target = fileURLToPath(spec);
      } catch {
        /* Invalid URLs are handled by the compiler. */
      }
    } else if (spec.startsWith(".") || isAbsolute(spec))
      target = resolve(repo, dirname(file), spec);
    if (target && /^(?:engine)(?:\/|$)/.test(relative(repo, target).replaceAll("\\", "/"))) {
      problems.push(
        `${location}: ${spec}; import the engine through its package contracts, not filesystem paths`,
      );
    }
  }
  return problems;
}

export function exportViolations(exports, repo = root) {
  const problems = [];
  for (const [key, target] of Object.entries(exports)) {
    if (!/^\.\/[a-z][a-z0-9/-]*$/.test(key) || key === "./src" || key.startsWith("./src/")) {
      problems.push(
        `engine/package.json: ${key}; export only explicit named contracts, never source paths or patterns`,
      );
    }
    if (
      typeof target !== "string" ||
      !target.startsWith("./src/") ||
      target.includes("*") ||
      !resolve(repo, "engine", target).startsWith(resolve(repo, "engine/src") + "/")
    ) {
      problems.push(
        `engine/package.json: ${key}; contract must resolve to one engine-owned source file`,
      );
    } else if (
      !existsSync(resolve(repo, "engine", target)) ||
      !statSync(resolve(repo, "engine", target)).isFile()
    ) {
      problems.push(`engine/package.json: ${key}; contract target does not exist: ${target}`);
    }
    if (
      typeof target === "string" &&
      target.startsWith("./src/testing/") &&
      !key.startsWith("./testing/")
    ) {
      problems.push(`engine/package.json: ${key}; test support must be namespaced under testing`);
    }
  }
  return problems;
}

function main() {
  const exports = JSON.parse(readFileSync(resolve(root, "engine/package.json"), "utf8")).exports;
  const files = [
    ...new Set(
      execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1 << 27,
      }).split("\0"),
    ),
  ].filter(
    (file) =>
      !file.startsWith("engine/") &&
      /\.[cm]?[jt]sx?$/.test(file) &&
      existsSync(resolve(root, file)),
  );
  const problems = [
    ...exportViolations(exports),
    ...files.flatMap((file) =>
      contractViolations(file, readFileSync(resolve(root, file), "utf8"), exports),
    ),
  ];
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `engine public API: ${files.length} external source files use explicit contracts; no implementation-import exceptions`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
