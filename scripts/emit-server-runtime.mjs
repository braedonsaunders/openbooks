// Emit @openbooks/engine, @openbooks/schema, and the workspace packages they
// load at runtime as one JavaScript file per source file, then run the
// production Next build while package exports point the `node` condition at
// that output. Exports are restored afterward so tests keep importing source.
// Pass --keep-exports to leave the node condition in place (next start without
// the runtime resolver).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_RUNTIME_PACKAGES,
  conditionalExport,
  distSpecifier,
  exportSource,
} from "./server-runtime-packages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backupPath = join(
  tmpdir(),
  `openbooks-export-backup-${createHash("sha1").update(root).digest("hex").slice(0, 12)}.json`,
);

const separator = process.argv.indexOf("--");
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
const keepExports = process.argv.includes("--keep-exports");
const skipEmit = process.argv.includes("--skip-emit");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readBackup() {
  if (!existsSync(backupPath)) return null;
  return JSON.parse(readFileSync(backupPath, "utf8"));
}

function restoreBackup() {
  const backup = readBackup();
  if (!backup) return;
  for (const [rel, contents] of Object.entries(backup)) {
    writeFileSync(join(root, rel), contents);
  }
  rmSync(backupPath, { force: true });
}

function packageManifest(relDir) {
  return join(relDir, "package.json");
}

function rewriteExports() {
  const backup = {};
  const manifests = [];
  for (const pkg of SERVER_RUNTIME_PACKAGES) {
    const rel = packageManifest(pkg.dir);
    const original = readFileSync(join(root, rel), "utf8");
    backup[rel] = original;
    manifests.push([rel, JSON.parse(original), pkg]);
  }
  writeFileSync(backupPath, JSON.stringify(backup));
  for (const [rel, manifest, pkg] of manifests) {
    if (pkg.schemaPatterns) {
      // `./src/*.ts` is the engine's deep import. `./src/*` is the extensionless
      // import client components already use; the star maps onto the .ts file.
      const sourcePattern = conditionalExport("./src/*.ts");
      manifest.exports = {
        ".": conditionalExport("./src/index.ts"),
        "./src/*.ts": sourcePattern,
        "./src/*": sourcePattern,
      };
    } else if (manifest.exports && typeof manifest.exports === "object") {
      const next = {};
      for (const [key, value] of Object.entries(manifest.exports)) {
        const source = exportSource(value);
        next[key] = source ? conditionalExport(source) : value;
      }
      manifest.exports = next;
    }
    writeFileSync(join(root, rel), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function assertEmitted(relDir, source) {
  const js = distSpecifier(source);
  if (!js || !existsSync(join(root, relDir, js))) {
    fail(`emit did not write ${relDir}/${js ?? source}`);
  }
}

function rewriteExtensionlessSpecifiers(relDir) {
  const distRoot = join(root, relDir, "dist");
  const visit = (rel) => {
    const dir = join(distRoot, rel);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(rel, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const file = join(distRoot, child);
      const source = readFileSync(file, "utf8");
      const next = source.replace(
        /(from\s*|import\s*\(\s*|import\s*)(["'])(\.[^"']+)\2/g,
        (full, lead, quote, specifier) => {
          if (/\.(?:js|mjs|cjs|json|node|wasm)$/.test(specifier)) return full;
          const base = join(dirname(file), specifier);
          if (existsSync(`${base}.js`)) return `${lead}${quote}${specifier}.js${quote}`;
          if (existsSync(join(base, "index.js"))) {
            const index = specifier.endsWith("/")
              ? `${specifier}index.js`
              : `${specifier}/index.js`;
            return `${lead}${quote}${index}${quote}`;
          }
          return full;
        },
      );
      if (next !== source) writeFileSync(file, next);
    }
  };
  visit("");
}

function copyAssets(relDir) {
  const srcRoot = join(root, relDir, "src");
  const distRoot = join(root, relDir, "dist");
  const walk = (rel) => {
    const dir = join(srcRoot, rel);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (/\.(tsx?|mts|cts)$/.test(entry.name) || entry.name.includes(".test.")) continue;
      const target = join(distRoot, child);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(srcRoot, child), target);
    }
  };
  walk("");
}

function emitPackage(relDir) {
  const outDir = join(root, relDir, "dist");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      noEmit: false,
      declaration: false,
      sourceMap: false,
      outDir: "dist",
      rootDir: "src",
      types: ["node"],
    },
    include: ["src"],
    exclude: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/*.test.mts",
      "src/**/*.child.ts",
      "src/**/*.child.mts",
    ],
  };
  const configFile = join(root, relDir, "tsconfig.emit.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  const tscBin = join(root, "node_modules/typescript/bin/tsc");
  const nodeArgs = [tscBin, "-p", configFile, "--pretty", "false"];
  const heavy = "/home/bsaun/bin/ob-heavy";
  const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" };
  const result = existsSync(heavy)
    ? spawnSync("flock", ["-w", "3600", "/tmp/ob-tsc.lock", heavy, process.execPath, ...nodeArgs], {
        stdio: "inherit",
        env,
        cwd: join(root, relDir),
      })
    : spawnSync(process.execPath, nodeArgs, { stdio: "inherit", env, cwd: join(root, relDir) });
  if (result.status !== 0)
    fail(`tsc emit failed for ${relDir} (exit ${result.status ?? "signal"})`);
  rmSync(configFile, { force: true });
  rewriteExtensionlessSpecifiers(relDir);
  copyAssets(relDir);
}

function runCommand() {
  if (command.length === 0) return 0;
  const [bin, ...args] = command;
  const webDir = join(root, "web");
  const heavy = "/home/bsaun/bin/ob-heavy";
  let file = bin;
  let fileArgs = args;
  let cwd = process.cwd();
  if (bin === "next") {
    file = process.execPath;
    fileArgs = [join(root, "node_modules/next/dist/bin/next"), ...args];
    cwd = webDir;
  }
  const wrapped = existsSync(heavy)
    ? spawnSync(heavy, [file, ...fileArgs], { stdio: "inherit", cwd, env: process.env })
    : spawnSync(file, fileArgs, { stdio: "inherit", cwd, env: process.env });
  return wrapped.status ?? 1;
}

if (process.argv.includes("--rewrite-specifiers-only")) {
  for (const pkg of SERVER_RUNTIME_PACKAGES) rewriteExtensionlessSpecifiers(pkg.dir);
  process.exit(0);
}

if (process.argv.includes("--restore-only")) {
  if (existsSync(backupPath)) restoreBackup();
  process.exit(0);
}

if (existsSync(backupPath)) {
  console.log("Restoring package exports left by an interrupted runtime emit.");
  restoreBackup();
}

if (!skipEmit) for (const pkg of SERVER_RUNTIME_PACKAGES) emitPackage(pkg.dir);
assertEmitted("engine", "./src/platform/db.ts");
assertEmitted("engine", "./src/composition/install.ts");
assertEmitted("schema", "./src/index.ts");
assertEmitted("packages/jobs", "./src/index.ts");
assertEmitted("packages/forms-core", "./src/identifiers.ts");
assertEmitted("packages/reports", "./src/per-share.ts");
assertEmitted("packages/networking", "./src/ssrf.ts");

let code = 0;
rewriteExports();
try {
  code = runCommand();
} finally {
  if (keepExports) {
    console.log(
      "Left package exports pointing the node condition at dist. Restore with another emit, or delete the backup after you no longer need next start to resolve dist.",
    );
  } else {
    restoreBackup();
  }
}
process.exit(code);
