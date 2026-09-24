// source-pin-contract: sandbox-wipe guard GUC identity; every guard swept is derived by walking schema/migrations/generated, wipe setters derived from engine sources
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

test("every file in the migration directory is a well-formed forward migration", () => {
  // The canonical baseline plus reviewed forward migrations — anything else
  // in this directory is an unreviewed artifact, not a migration. Asserted
  // as a shape rule, not an inventory: a new reviewed migration with a valid
  // ordinal passes without re-pinning, while a stray artifact fails. Ordinal
  // uniqueness and ordering live in migration-ordinals; header spellings in
  // the migration-headers gate; upgrade decisions in the preflight gate.
  const generated = readdirSync("schema/migrations/generated")
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.ok(
    generated.includes("0001_baseline.sql"),
    "the chain's root baseline must be present",
  );
  const malformed = generated.filter(
    (file) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(file),
  );
  assert.deepEqual(
    malformed,
    [],
    `these are not reviewer-allocated forward migrations: ${malformed.join(", ")}`,
  );
});

test("every effective sandbox-wipe guard reads the GUC the wipe source sets", () => {
  // The wipe source (sandbox lifecycle) and the scratch-teardown path must
  // agree on one GUC, and every storage guard that honors a wipe must read
  // exactly that GUC — directly where it defines the mapping, through the
  // canonical helper everywhere else. A guard that trusts a raw GUC, or a
  // drifted name, silently stops honoring wipes (or honors forged ones).
  const generatedDir = "schema/migrations/generated";
  const migrationFiles = readdirSync(generatedDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrationSources = new Map(
    migrationFiles.map((file) => [file, readFileSync(`${generatedDir}/${file}`, "utf8")]),
  );
  const lifecycleSource = readFileSync("engine/src/sandbox/lifecycle.ts", "utf8");
  const fixtureWipeSource = readFileSync("engine/src/testing/fixtures.ts", "utf8");
  const setterMatch = lifecycleSource.match(
    /set_config\('([a-z0-9_.]+\.sandbox_wipe)', 'on', true\)/,
  );
  assert.ok(setterMatch, "sandbox lifecycle must set its wipe GUC explicitly");
  const wipeGuc = setterMatch[1]!;
  assert.match(
    fixtureWipeSource,
    new RegExp(`set_config\\('${wipeGuc.replaceAll(".", "\\.")}', 'on', true\\)`),
    "scratch teardown must use the same wipe GUC as sandbox lifecycle",
  );

  // Build the final function catalog in filename order: later forward
  // migrations replace earlier bodies, so this checks the guards a live
  // database actually has — including ones a later migration could
  // reintroduce under a drifted name.
  const effectiveFunctions = new Map<string, string>();
  const functionDefinition =
    /CREATE(?: OR REPLACE)? FUNCTION public\.([a-z0-9_]+)\([^;]*?\)\s+RETURNS[\s\S]*?\s+AS (\$[a-z0-9_]*\$)([\s\S]*?)\2;/gi;
  for (const source of migrationSources.values()) {
    for (const match of source.matchAll(functionDefinition)) {
      effectiveFunctions.set(match[1]!, match[3]!);
    }
  }
  const effectiveWipeBodies = new Map(
    [...effectiveFunctions].filter(([, body]) => body.includes("sandbox_wipe")),
  );
  assert.ok(
    effectiveWipeBodies.size > 0,
    "expected wipe-honoring guards in the effective catalog",
  );
  for (const [functionName, body] of effectiveWipeBodies) {
    assert.doesNotMatch(body, /app\.sandbox_wipe/, `${functionName} retains the drifted GUC`);
    if (functionName === "openbooks_sandbox_wipe_allowed") {
      // The mapping definition itself: the one place allowed to read the raw
      // GUC, and it must be the canonical one.
      assert.match(
        body,
        new RegExp(`current_setting\\('${wipeGuc.replaceAll(".", "\\.")}'`),
        "the wipe helper must read the wipe source's GUC",
      );
      continue;
    }
    // Every other guard bypasses only through the helper, never by reading a
    // wipe GUC itself: a raw read trusts whatever the session claims, while
    // the helper is the authorized DELETE path the wipe source sets.
    assert.match(
      body,
      /openbooks_sandbox_wipe_allowed\(/,
      `${functionName} must bypass only through the canonical wipe helper`,
    );
    assert.doesNotMatch(
      body,
      /current_setting\([^)]*sandbox_wipe/i,
      `${functionName} must not trust a raw wipe GUC in its body`,
    );
  }
});
