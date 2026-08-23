import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  REDACTION,
  buildCallbacks,
  containsProhibitedIdentifier,
  loadProhibitedIdentifierHashes,
  parseProhibitedIdentifierHashes,
  redactLikeCallbacks,
  tokensLikeGate,
} from "./build-callbacks.mjs";
import {
  plannedPurgeMatches,
  prohibitedPathPatterns,
} from "./dry-run.mjs";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const gateSourcePath = join(repositoryRoot, "scripts", "check-history-hygiene.mjs");
const filterRepoBinary = (() => {
  try {
    return execFileSync("/opt/homebrew/bin/git-filter-repo", ["--version"], { encoding: "utf8" }) && "/opt/homebrew/bin/git-filter-repo";
  } catch {
    try {
      execFileSync("git-filter-repo", ["--version"], { encoding: "utf8" });
      return "git-filter-repo";
    } catch {
      return undefined;
    }
  }
})();

const syntheticTokens = ["zzfixtcorp", "zzfixt_tenant7", "widgetfixtco"];
const syntheticHashes = new Set(
  syntheticTokens.map((token) => createHash("sha256").update(token).digest("hex")),
);

const adversarialCorpus = [
  "",
  "src/app.ts",
  "README.md",
  "reports/zzfixtcorp-summary.csv",
  "REPORTS/ZZFIXTCORP-Summary.CSV",
  "dir/zzfixt_tenant7/data.bin",
  "zzfixtcorp",
  "ZZFIXTCORP",
  "prefix-zzfixtcorp_suffix",
  "zzfixtcorpzzfixtcorp",
  "a/zzfixtcorp/b/zzfixt_tenant7/c.txt",
  "widgetfixtco ledger.csv",
  "WIDGETFIXTCO-ledger.csv",
  "zz_fixtcorp",
  "zz fixt corp",
  "café-zzfixtcorp.txt",
  "tenant\u212A.txt",
  "na\u017Fledger.csv",
];

test("prohibited identifier hashes are loaded verbatim from the hygiene gate", () => {
  const hashes = loadProhibitedIdentifierHashes();
  const gateSource = readFileSync(gateSourcePath, "utf8");
  const expected = [...gateSource.matchAll(/"([0-9a-f]{64})"/gu)].map((match) => match[1]);
  assert.ok(expected.length > 0);
  assert.deepEqual([...hashes].sort(), [...new Set(expected)].sort());
});

test("hash parsing rejects malformed gate sources instead of guessing", () => {
  assert.throws(
    () => parseProhibitedIdentifierHashes('const other = new Set(["a"]);'),
    /could not find prohibitedIdentifierHashes/,
  );
  assert.throws(
    () => parseProhibitedIdentifierHashes('const prohibitedIdentifierHashes = new Set([]);'),
    /unexpected format/,
  );
  assert.throws(
    () => parseProhibitedIdentifierHashes(
      'const prohibitedIdentifierHashes = new Set(["a".repeat(64)]);',
    ),
    /unexpected format/,
  );
  const duplicated = JSON.stringify([
    "6e5e825c558c5d993bb79cd4384690edb8bf2ed67d5c623baaf34dcbc78aeb77",
    "6e5e825c558c5d993bb79cd4384690edb8bf2ed67d5c623baaf34dcbc78aeb77",
  ]);
  assert.throws(
    () =>
      parseProhibitedIdentifierHashes(
        `const prohibitedIdentifierHashes = new Set(${duplicated});`,
      ),
    /duplicates/,
  );
  assert.throws(
    () =>
      parseProhibitedIdentifierHashes(
        'const prohibitedIdentifierHashes = new Set([\n  "aa",\n]);',
      ),
    /unexpected format/,
  );
});

test("callback generation refuses a replacement literal the gate prohibits", () => {
  const poisoned = new Set([createHash("sha256").update("redacted").digest("hex")]);
  assert.throws(() => buildCallbacks(poisoned), /replacement literal/);
});

test("generated callbacks cover every loaded hash", () => {
  const callbacks = buildCallbacks();
  const hashes = loadProhibitedIdentifierHashes();
  for (const callback of [callbacks.filenameCallback, callbacks.messageCallback]) {
    for (const hash of hashes) {
      assert.ok(callback.includes(hash));
    }
  }
  assert.ok(callbacks.filenameCallback.startsWith("if filename is None:"));
  assert.ok(!callbacks.messageCallback.includes("is None"));
});

test("redaction clears every violation the gate flags and preserves everything else", () => {
  for (const value of adversarialCorpus) {
    const flagged = containsProhibitedIdentifier(value, syntheticHashes);
    const transformed = redactLikeCallbacks(value, syntheticHashes);
    if (flagged) {
      assert.ok(
        !containsProhibitedIdentifier(transformed, syntheticHashes),
        `residual violation after redaction: ${JSON.stringify(value)} -> ${JSON.stringify(transformed)}`,
      );
      assert.ok(transformed.includes(REDACTION));
    } else {
      assert.equal(transformed, value);
    }
    assert.equal(redactLikeCallbacks(transformed, syntheticHashes), transformed);
  }
});

test("gate tokenization agrees with redaction coverage on the corpus", () => {
  for (const value of adversarialCorpus) {
    const flaggedByTokens = [...tokensLikeGate(value)].some((token) =>
      syntheticHashes.has(createHash("sha256").update(token).digest("hex")),
    );
    assert.equal(flaggedByTokens, containsProhibitedIdentifier(value, syntheticHashes));
  }
});

function pythonCallbackRunner(callbackBody, inputVariable) {
  const indented = callbackBody
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
  return [
    "import sys",
    `def _apply(${inputVariable}):`,
    indented,
    "payload = sys.stdin.buffer.read()",
    'lines = payload.split(b"\\n")',
    'sys.stdout.buffer.write(b"\\n".join(_apply(line) for line in lines))',
    "",
  ].join("\n");
}

test("python execution of generated callbacks matches the javascript simulation byte for byte", () => {
  const { messageCallback, filenameCallback } = buildCallbacks(syntheticHashes);
  const payload = Buffer.from(adversarialCorpus.join("\n"), "utf8");

  const pythonMessage = execFileSync("python3", ["-c", pythonCallbackRunner(messageCallback, "message")], {
    input: payload,
    maxBuffer: 16 * 1024 * 1024,
  });
  const pythonFilename = execFileSync("python3", ["-c", pythonCallbackRunner(filenameCallback, "filename")], {
    input: payload,
    maxBuffer: 16 * 1024 * 1024,
  });

  const simulated = adversarialCorpus.map((line) => redactLikeCallbacks(line, syntheticHashes));
  assert.equal(pythonMessage.toString("utf8"), simulated.join("\n"));
  assert.equal(pythonFilename.toString("utf8"), simulated.join("\n"));
});

function gitIn(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}

function trackedFilePaths(cwd) {
  const output = gitIn(cwd, "log", "--all", "--pretty=format:", "--name-only").toString("utf8");
  return [...new Set(output.split("\n").filter(Boolean))];
}

function commitSubjects(cwd) {
  const output = gitIn(cwd, "log", "--all", "--format=%H%x09%s").toString("utf8");
  return output.split("\n").filter(Boolean).map((line) => line.split("\t").slice(1).join("\t"));
}

function classifyResidual(values, hashes) {
  return values.filter(
    (value) =>
      prohibitedPathPatterns.some((pattern) => pattern.test(value)) ||
      containsProhibitedIdentifier(value, hashes),
  );
}

test("rehearsal with real git-filter-repo reproduces the simulation with zero residual", (t) => {
  if (!filterRepoBinary) {
    t.skip("git-filter-repo is not installed; install it to rehearse the rewrite transforms");
    return;
  }
  const headBefore = gitIn(repositoryRoot, "rev-parse", "HEAD").toString("utf8").trim();

  const fixtureRoot = mkdtempSync(join(tmpdir(), "openbooks-history-rewrite-fixture-"));
  assert.ok(fixtureRoot.startsWith(tmpdir()));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  gitIn(fixtureRoot, "init", "-b", "main");

  const writeTree = (files) => {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = join(fixtureRoot, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, contents);
    }
  };
  const commit = (message) => {
    gitIn(fixtureRoot, "add", "-A");
    gitIn(fixtureRoot, "-c", "commit.gpgsign=false", "commit", "-m", message);
  };

  writeTree({ "README.md": "fixture base\n", "src/app.ts": "export {};\n" });
  commit("Initial fixture commit");

  writeTree({
    ".local/tenant-migrations/V1__init.sql": "select 1;\n",
    "pkg/.local/tenant-migrations/patch.sql": "select 2;\n",
    "account-data/list.csv": "id,name\n",
    "clients/account-data/deep/nested.csv": "id,name\n",
    "extraction/run.py": "print(1)\n",
    "a/b/extraction/tool.py": "print(2)\n",
    "objects-list.txt": "blob\n",
    "sub/objects-list.txt": "blob\n",
    "docs/notes.md": "notes\n",
  });
  commit("Stage private data classes");

  writeTree({ "reports/zzfixtcorp-summary.csv": "month,total\n" });
  commit("Import zzfixtcorp ledger extract\n\nBody mentions zzfixt_tenant7 and widgetfixtco.");

  writeTree({
    "extraction-tools/keep.txt": "keeper\n",
    "accounting/ledger.txt": "rows\n",
    "objects-list.md": "# doc\n",
    "src/.local/settings.json": "{}\n",
  });
  commit("Add lookalike paths that must survive");

  gitIn(fixtureRoot, "branch", "archive", "HEAD~1");
  gitIn(fixtureRoot, "tag", "pre-rewrite-fixt");

  const commitCountBefore = Number(gitIn(fixtureRoot, "rev-list", "--all", "--count").toString("utf8").trim());
  assert.equal(commitCountBefore, 4);

  const pathsBefore = trackedFilePaths(fixtureRoot);
  const predictedSurvivors = new Set();
  let purgedPredictions = 0;
  let renamedPredictions = 0;
  for (const path of pathsBefore) {
    if (plannedPurgeMatches(path)) {
      purgedPredictions += 1;
      continue;
    }
    const transformed = redactLikeCallbacks(path, syntheticHashes);
    if (transformed !== path) renamedPredictions += 1;
    predictedSurvivors.add(transformed);
  }

  const residualBefore = classifyResidual([...pathsBefore, ...commitSubjects(fixtureRoot)], syntheticHashes);
  assert.ok(residualBefore.length > 0, "fixture must contain violations before the rehearsal");
  assert.ok(pathsBefore.some((path) => prohibitedPathPatterns.some((pattern) => pattern.test(path))));
  assert.ok(commitSubjects(fixtureRoot).some((subject) => subject.includes("zzfixtcorp")));

  const { filenameCallback, messageCallback } = buildCallbacks(syntheticHashes);
  const pathArguments = [];
  for (const expression of [
    "--path=.local/tenant-migrations",
    "--path-glob=*/.local/tenant-migrations",
    "--path-glob=*/.local/tenant-migrations/*",
    "--path=account-data",
    "--path-glob=*/account-data",
    "--path-glob=*/account-data/*",
    "--path=extraction",
    "--path-glob=*/extraction",
    "--path-glob=*/extraction/*",
    "--path-glob=objects-list.txt",
    "--path-glob=*/objects-list.txt",
  ]) {
    pathArguments.push(expression.slice(0, expression.indexOf("=")), expression.slice(expression.indexOf("=") + 1));
  }
  execFileSync(
    filterRepoBinary,
    ["--force", "--invert-paths", ...pathArguments, "--filename-callback", filenameCallback, "--message-callback", messageCallback],
    { cwd: fixtureRoot, maxBuffer: 64 * 1024 * 1024 },
  );

  const pathsAfter = trackedFilePaths(fixtureRoot);
  assert.deepEqual([...new Set(pathsAfter)].sort(), [...predictedSurvivors].sort());
  assert.equal(purgedPredictions, 8, `expected the private-data files to be purged, got ${purgedPredictions}`);
  assert.equal(renamedPredictions, 1);
  assert.ok(predictedSurvivors.has("docs/notes.md"));

  const residualAfter = classifyResidual([...new Set(pathsAfter)], syntheticHashes);
  assert.deepEqual(residualAfter, []);
  const subjectsAfter = commitSubjects(fixtureRoot);
  assert.deepEqual(classifyResidual(subjectsAfter, syntheticHashes), []);
  assert.ok(subjectsAfter.some((subject) => subject.includes(REDACTION)));
  assert.ok(subjectsAfter.every((subject) => !syntheticTokens.some((token) => subject.toLowerCase().includes(token))));

  const commitCountAfter = Number(gitIn(fixtureRoot, "rev-list", "--all", "--count").toString("utf8").trim());
  assert.equal(commitCountAfter, commitCountBefore);
  gitIn(fixtureRoot, "rev-parse", "--verify", "refs/heads/archive");
  gitIn(fixtureRoot, "rev-parse", "--verify", "refs/tags/pre-rewrite-fixt");

  const commitMap = readFileSync(join(fixtureRoot, ".git", "filter-repo", "commit-map"), "utf8")
    .trim()
    .split("\n")
    .slice(1);
  assert.equal(commitMap.length, commitCountBefore);
  assert.ok(
    commitMap.every((line) => !line.endsWith("0000000000000000000000000000000000000000")),
  );

  assert.equal(gitIn(fixtureRoot, "show", "HEAD:extraction-tools/keep.txt").toString("utf8"), "keeper\n");
  assert.equal(gitIn(fixtureRoot, "show", "HEAD:README.md").toString("utf8"), "fixture base\n");
  assert.equal(gitIn(fixtureRoot, "show", "HEAD:objects-list.md").toString("utf8"), "# doc\n");

  const headAfter = gitIn(repositoryRoot, "rev-parse", "HEAD").toString("utf8").trim();
  assert.equal(headAfter, headBefore);
});

test("read-only dry-run passes against the current openbooks history", () => {
  const stdout = execFileSync(process.execPath, ["scripts/history-rewrite/dry-run.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.match(stdout, /PASS: the planned transforms simulate a clean full-history gate\./);
});
