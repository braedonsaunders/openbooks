import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { caseDigest, runId, sourceSha } from "./provenance.ts";

test("source provenance rejects a borrowed environment label and refuses a dirty tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "openbooks-source-"));
  const savedSource = process.env.OPENBOOKS_SOURCE_SHA;
  const savedGithub = process.env.GITHUB_SHA;
  try {
    delete process.env.OPENBOOKS_SOURCE_SHA;
    delete process.env.GITHUB_SHA;
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("-c", "user.name=Verification", "-c", "user.email=verification@example.test", "commit", "--quiet", "--allow-empty", "-m", "Initial source");
    const head = git("rev-parse", "HEAD");
    assert.equal(sourceSha(directory), head);
    process.env.GITHUB_SHA = "b".repeat(40);
    assert.throws(() => sourceSha(directory), /does not match the checked-out full commit/);
    process.env.OPENBOOKS_SOURCE_SHA = head;
    assert.equal(sourceSha(directory), head, "the explicitly checked-out workflow source takes precedence");
    writeFileSync(join(directory, "changed.ts"), "export const changed = true;\n");
    assert.equal(sourceSha(directory), null, "uncommitted source cannot be labelled as HEAD");
  } finally {
    if (savedSource === undefined) delete process.env.OPENBOOKS_SOURCE_SHA;
    else process.env.OPENBOOKS_SOURCE_SHA = savedSource;
    if (savedGithub === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = savedGithub;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runId is null outside CI and the run id inside it", () => {
  const saved = process.env.GITHUB_RUN_ID;
  try {
    delete process.env.GITHUB_RUN_ID;
    assert.equal(runId(), null);
    process.env.GITHUB_RUN_ID = "12345";
    assert.equal(runId(), "12345");
  } finally {
    if (saved === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = saved;
  }
});

test("caseDigest is the sha256 of the serialized case payload", () => {
  const cases = [{ id: "a", status: "pass" }];
  assert.equal(caseDigest(cases), createHash("sha256").update(JSON.stringify(cases)).digest("hex"));
  assert.notEqual(caseDigest([{ id: "a", status: "pass" }]), caseDigest([{ id: "a", status: "fail" }]));
});
