import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { caseDigest, runId, sourceSha } from "./provenance.ts";

test("sourceSha prefers the explicit source override over the CI default", () => {
  const savedSource = process.env.OPENBOOKS_SOURCE_SHA;
  const savedGithub = process.env.GITHUB_SHA;
  try {
    process.env.OPENBOOKS_SOURCE_SHA = "abc123";
    process.env.GITHUB_SHA = "def456";
    assert.equal(sourceSha(), "abc123");
    delete process.env.OPENBOOKS_SOURCE_SHA;
    assert.equal(sourceSha(), "def456");
  } finally {
    if (savedSource === undefined) delete process.env.OPENBOOKS_SOURCE_SHA;
    else process.env.OPENBOOKS_SOURCE_SHA = savedSource;
    if (savedGithub === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = savedGithub;
  }
});

test("sourceSha falls back to the checkout HEAD outside CI", () => {
  const savedSource = process.env.OPENBOOKS_SOURCE_SHA;
  const savedGithub = process.env.GITHUB_SHA;
  try {
    delete process.env.OPENBOOKS_SOURCE_SHA;
    delete process.env.GITHUB_SHA;
    const sha = sourceSha();
    assert.ok(sha && /^[0-9a-f]{40}$/.test(sha), `expected a full HEAD sha, got ${sha}`);
  } finally {
    if (savedSource !== undefined) process.env.OPENBOOKS_SOURCE_SHA = savedSource;
    if (savedGithub !== undefined) process.env.GITHUB_SHA = savedGithub;
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
