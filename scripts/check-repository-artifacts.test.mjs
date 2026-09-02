import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const checker = new URL("./check-repository-artifacts.mjs", import.meta.url);

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "openbooks-artifact-check-"));
  execFileSync("git", ["init", "--quiet", directory]);
  return directory;
}

function run(directory) {
  return spawnSync(process.execPath, [checker.pathname], {
    cwd: directory,
    encoding: "utf8",
  });
}

test("accepts ordinary files and repository-relative symlinks", () => {
  const directory = repository();
  writeFileSync(join(directory, "target.txt"), "ok\n");
  symlinkSync("target.txt", join(directory, "relative-link"));
  execFileSync("git", ["add", "target.txt", "relative-link"], { cwd: directory });

  const result = run(directory);
  assert.equal(result.status, 0, result.stderr);
});

test("rejects tracked NUL-containing source blobs", () => {
  const directory = repository();
  writeFileSync(join(directory, "src.ts"), Buffer.from("export const value = 1;\0\n"));
  execFileSync("git", ["add", "src.ts"], { cwd: directory });

  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NUL bytes/);
  assert.match(result.stderr, /src\.ts/);
});

test("accepts clean tracked source blobs", () => {
  const directory = repository();
  writeFileSync(join(directory, "src.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "src.ts"], { cwd: directory });

  const result = run(directory);
  assert.equal(result.status, 0, result.stderr);
});

test("accepts legitimate tracked binary assets", () => {
  const directory = repository();
  writeFileSync(
    join(directory, "asset.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  execFileSync("git", ["add", "asset.png"], { cwd: directory });

  const result = run(directory);
  assert.equal(result.status, 0, result.stderr);
});

test("rejects tracked dependency artifacts", () => {
  const directory = repository();
  mkdirSync(join(directory, "node_modules"));
  writeFileSync(join(directory, "node_modules", "leak.txt"), "leak\n");
  execFileSync("git", ["add", "-f", "node_modules/leak.txt"], { cwd: directory });

  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dependency artifacts must not be tracked/);
});

test("rejects absolute symlink targets", () => {
  const directory = repository();
  symlinkSync("/private/tmp/machine-only", join(directory, "machine-link"));
  execFileSync("git", ["add", "machine-link"], { cwd: directory });

  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /machine-specific symlink target/);
});
