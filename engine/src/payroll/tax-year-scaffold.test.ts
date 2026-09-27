// source-pin-contract: the generator's product is a draft edition plus runner instructions; the scratch copy proves generated editions stay isolated from the checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { payrollTaxYearSupport } from "./packs.ts";
import { unfilledPaths } from "./unfilled.ts";

/**
 * The rollover scaffold (scripts/payroll-new-tax-year.ts).
 *
 * The generator's whole promise is that adding a tax year becomes "fill in the
 * published values and make the goldens pass". This test holds it to both halves
 * of that: it generates a real edition for a synthetic year, proves the pack
 * refuses to calculate with it and that the operator is directed to the shared
 * country runner for citation-backed golden and refusal rows.
 *
 * It generates into a THROWAWAY COPY of the engine sources, never the checkout.
 * The generator's job is to write a real edition into the real tree, so the test
 * used to let it, snapshot the touched files, and restore them in `finally`.
 * That is safe alone and unsafe in a suite: sibling files import the same packs
 * concurrently, and for the moment the barrel named rates-2099.ts while the
 * module was being written and then removed, any test importing
 * engine/src/payroll/us/editions.ts died with ERR_MODULE_NOT_FOUND — a flake
 * that blames an innocent file. Restoring in `finally` also loses the race with
 * a crash, which would leave a generated draft edition in the working tree,
 * showing up as a scaffolded year on the setup screen.
 *
 * The year is 2099: inside the accepted range, decades past any edition anybody
 * will transcribe.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const YEAR = 2099;

/**
 * The throwaway root the generator writes under, holding a copy of engine/src
 * at its repo-relative path so every declared path lands where it would.
 *
 * It lives INSIDE the repo on purpose. The copied year module and pack modules
 * resolve `node_modules` and the nearest package.json by walking UP — from
 * engine/.tmp-scaffold-<pid>/ that finds engine/package.json ("type": "module")
 * and the repo's node_modules, exactly as the real sources do. An OS temp
 * directory resolves neither.
 *
 * Suffixed with the pid so concurrent runs cannot collide, gitignored, and
 * removed in `after`; if the process dies mid-generation the leftovers are
 * ignored junk rather than a modified checked-in file.
 */
const SCRATCH_ROOT = join(REPO_ROOT, "engine", `.tmp-scaffold-${process.pid}`);

const GENERATOR = "scripts/payroll-new-tax-year.ts";

before(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  mkdirSync(join(SCRATCH_ROOT, "engine"), { recursive: true });
  cpSync(join(REPO_ROOT, "engine", "src"), join(SCRATCH_ROOT, "engine", "src"), { recursive: true });
  // The generator too, at its repo-relative path. It reads the DECLARATIONS
  // from its own checkout (`../engine/src/payroll/tax-years.ts`), so the copy
  // reads the copied packs — the only way to drive it against a pack state
  // nobody has transcribed yet, such as a year the CRA has published and
  // Revenu Québec has not.
  mkdirSync(join(SCRATCH_ROOT, "scripts"), { recursive: true });
  cpSync(join(REPO_ROOT, GENERATOR), join(SCRATCH_ROOT, GENERATOR));
});

after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

/** A scaffolded path inside the throwaway copy. */
function scratch(relative: string): string {
  return join(SCRATCH_ROOT, relative);
}

/**
 * Runs the generator from the repo (so it reads the real declarations) but
 * writes under the throwaway root.
 */
function runGenerator(
  country: string,
  extra: string[] = [],
  root: string = SCRATCH_ROOT,
): { status: number; out: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", GENERATOR,
      "--country", country, "--year", String(YEAR), "--root", root, ...extra,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * The COPY of the generator, so it reads the throwaway copy's declarations
 * rather than the checkout's. Everything else is the same run.
 */
function runCopiedGenerator(country: string): { status: number; out: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", GENERATOR,
      "--country", country, "--year", String(YEAR), "--root", SCRATCH_ROOT,
    ],
    { cwd: SCRATCH_ROOT, encoding: "utf8" },
  );
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("the generator lists what each pack has loaded, and refuses an undeclared pack", () => {
  const listed = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/payroll-new-tax-year.ts", "--list"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /CA: engine\/src\/payroll\/canada\/rates\.ts/);
  assert.match(listed.stdout, /US: engine\/src\/payroll\/us\/rates\.ts/);
  assert.match(listed.stdout, /published: 2026/);

  const unknown = runGenerator("ZZ");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.out, /declares no statutory tax years/);
});

test("a published year is never overwritten by the generator", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", "scripts/payroll-new-tax-year.ts",
      "--country", "US", "--year", "2026", "--root", SCRATCH_ROOT,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /already has PUBLISHED statutory tables for 2026/);
  // And nothing was written over the transcribed edition, nor beside it.
  assert.match(
    readFileSync(scratch("engine/src/payroll/us/rates.ts"), "utf8"),
    /status: "published"/,
  );
  assert.ok(!existsSync(scratch("engine/src/payroll/us/rates-2026.ts")));
});

test("the US scaffold produces a DRAFT module and shared-runner row instructions", async () => {
  const support = payrollTaxYearSupport("US");
  // The declared paths are repo-relative, so they land under the throwaway root.
  assert.deepEqual(support.scaffold.files.map((file) => file.path), ["engine/src/payroll/us/rates-{year}.ts"]);
  assert.ok(support.scaffold.barrels.length > 0);

  const generated = runGenerator("US");
  assert.equal(generated.status, 0, generated.out);
  assert.match(generated.out, /created  engine\/src\/payroll\/us\/rates-2099\.ts/); // source-path: synthetic
  // The barrel lists every wired year, derived from the directory rather than
  // a hand-maintained list, so the line grows as prior-year editions land.
  // Assert 2099 is among them, not that it is alone -- pinning the whole list
  // makes this fail the day a pack gains a year that has nothing to do with it.
  assert.match(generated.out, /wired    engine\/src\/payroll\/us\/editions\.ts → (?:[\d, ]*\b)?2099\b/);
  // The instructions are the pack's own, in order, and they name the sources.
  assert.match(generated.out, /Pub 15-T/);
  assert.ok(generated.out.includes("GOLDENS to engine/src/payroll/us/pub15t.test.ts"));
  assert.ok(generated.out.includes('citation: "IRS Pub 15-T (2099)'));
  assert.ok(generated.out.includes("REFUSALS in engine/src/payroll/us/pub15t.test.ts"));

  const modulePath = scratch("engine/src/payroll/us/rates-2099.ts");
  assert.ok(existsSync(modulePath) && !existsSync(scratch("engine/src/payroll/us/rates-2099.test.ts")));

  // 1. The edition is a DRAFT carrying placeholders, so nothing can withhold
  //    from it. Imported dynamically: it has never been loaded in this process.
  const edition = (await import(modulePath)) as { RATES_2099: Record<string, unknown> };
  assert.equal(edition.RATES_2099.status, "draft");
  const unfilled = unfilledPaths(edition.RATES_2099);
  assert.ok(unfilled.length > 20, `a skeleton must placehold every figure, found ${unfilled.length}`);
  assert.ok(unfilled.includes("fica.ssWageBase"));
  assert.ok(unfilled.includes("futa.grossRate"));

  // 2. The barrel was rewritten from the directory, so the year is wired in
  //    without anybody editing a hand-maintained list.
  assert.match(
    readFileSync(scratch("engine/src/payroll/us/editions.ts"), "utf8"),
    /import \{ RATES_2099 \} from "\.\/rates-2099\.ts";[\s\S]*RATES_2099,/,
  );

  // 3. Re-running is idempotent and never clobbers work in progress.
  const again = runGenerator("US");
  assert.equal(again.status, 0);
  assert.match(again.out, /exists   engine\/src\/payroll\/us\/rates-2099\.ts/); // source-path: synthetic

  // 4. The checkout never saw any of it: no draft edition beside the real
  //    tables, and the real barrel does not name a year nobody transcribed.
  assert.ok(!existsSync(join(REPO_ROOT, "engine/src/payroll/us/rates-2099.ts")));
  assert.doesNotMatch(
    readFileSync(join(REPO_ROOT, "engine/src/payroll/us/editions.ts"), "utf8"),
    /2099/,
  );
});

test("US, GB, IE, and SG scaffolds target their shared GOLDENS and REFUSALS tables", () => {
  const cases = [
    ["US", "engine/src/payroll/us/rates-{year}.ts", "engine/src/payroll/us/pub15t.test.ts"],
    ["GB", "engine/src/payroll/gb/rates-{year}.ts", "engine/src/payroll/gb/parity.test.ts"],
    ["IE", "engine/src/payroll/ie/rates-{year}.ts", "engine/src/payroll/ie/conformance.test.ts"],
    ["SG", "engine/src/payroll/sg/tax-year-{year}.ts", "engine/src/payroll/sg/cpf.test.ts"],
  ] as const;

  for (const [country, modulePattern, runner] of cases) {
    const support = payrollTaxYearSupport(country);
    assert.deepEqual(support.scaffold.files.map((file) => file.path), [modulePattern], country);
    const generated = runGenerator(country);
    assert.equal(generated.status, 0, generated.out);
    assert.ok(generated.out.includes(`GOLDENS to ${runner}`), country);
    assert.ok(generated.out.includes(`REFUSALS in ${runner}`), country);
    assert.ok(generated.out.includes("citation: "), country);
    const generatedModule = modulePattern.replace("{year}", String(YEAR));
    assert.ok(!existsSync(scratch(generatedModule.replace(/\.ts$/, ".test.ts"))), country);
  }
});

test("the CA scaffold covers Quebec too, because a CA year is not loaded without it", () => {
  const support = payrollTaxYearSupport("CA");
  const generated = support.scaffold.files.map((file) => file.path);
  assert.ok(generated.some((path) => path.includes("canada/rates-{year}.ts")));
  assert.ok(generated.some((path) => path.includes("canada/quebec/rates-{year}.ts")));
  assert.ok(generated.some((path) => path.endsWith("canada/rates-{year}.test.ts")));
  assert.ok(generated.some((path) => path.endsWith("canada/quebec/rates-{year}.test.ts")));
  assert.equal(support.scaffold.barrels.length, 2);

  // A dry run reports without writing anything.
  const dry = runGenerator("CA", ["--dry-run"]);
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /would wire engine\/src\/payroll\/canada\/quebec\/editions\.ts/);
  assert.ok(!existsSync(scratch("engine/src/payroll/canada/rates-2099.ts")));
  assert.ok(!existsSync(scratch("engine/src/payroll/canada/quebec/rates-2099.ts")));
  assert.doesNotMatch(
    readFileSync(scratch("engine/src/payroll/canada/editions.ts"), "utf8"),
    /2099/,
  );
  assert.ok(!existsSync(join(REPO_ROOT, "engine/src/payroll/canada/rates-2099.ts")));
});

/**
 * The partial rollover: the CRA publishes T4127 in November and Revenu Québec's
 * TP-1015 follows weeks later, so a CA year spends real calendar time published
 * federally and NOT published for Quebec. A guard that asked only "is there a
 * published country-wide edition?" answered "nothing to scaffold" in exactly
 * that window — the one window where the Quebec skeleton is the whole job, and
 * there was no other way to generate it.
 *
 * Driven through the COPIED generator so the mutated pack state is the one it
 * reads. The checkout is never in this state: its 2026 editions are published
 * on both sides.
 */
test("a year the country published but its own-tables region has not still scaffolds the region", () => {
  const federalModule = "engine/src/payroll/canada/rates-2099.ts";
  const quebecModule = "engine/src/payroll/canada/quebec/rates-2099.ts";
  const quebecBarrel = "engine/src/payroll/canada/quebec/editions.ts";

  // Both halves scaffold first, as a real rollover starts.
  const scaffolded = runGenerator("CA");
  assert.equal(scaffolded.status, 0, scaffolded.out);
  assert.ok(existsSync(scratch(federalModule)) && existsSync(scratch(quebecModule)));

  // Now the state under test: the CRA edition transcribed and PUBLISHED, and
  // Revenu Québec's not out — no module, and a barrel naming no 2099.
  const draft = readFileSync(scratch(federalModule), "utf8");
  const published = draft.replace('status: "draft"', 'status: "published"');
  assert.notEqual(published, draft, "the scaffolded federal module must carry a draft status");
  writeFileSync(scratch(federalModule), published, "utf8");
  rmSync(scratch(quebecModule));
  rmSync(scratch("engine/src/payroll/canada/quebec/rates-2099.test.ts"));
  cpSync(join(REPO_ROOT, quebecBarrel), scratch(quebecBarrel));

  const partial = runCopiedGenerator("CA");
  assert.equal(partial.status, 0, partial.out);
  assert.doesNotMatch(partial.out, /Nothing to scaffold/, partial.out);
  // It says which scope is done and which is not, rather than calling the year done.
  assert.match(partial.out, /2099 is already PUBLISHED for CA \(country-wide\)/);
  assert.match(partial.out, /still missing for CA · QC/);

  // The published federal edition is skipped, the missing Quebec half written.
  assert.match(partial.out, /exists   engine\/src\/payroll\/canada\/rates-2099\.ts/); // source-path: synthetic
  assert.match(partial.out, /created  engine\/src\/payroll\/canada\/quebec\/rates-2099\.ts/); // source-path: synthetic
  assert.match(partial.out, /created  engine\/src\/payroll\/canada\/quebec\/rates-2099\.test\.ts/);
  assert.equal(readFileSync(scratch(federalModule), "utf8"), published,
    "a published edition is never overwritten by a generator");
  assert.match(readFileSync(scratch(quebecModule), "utf8"), /status: "draft"/);
  assert.match(readFileSync(scratch(quebecBarrel), "utf8"), /QC_RATES_2099,/);

  // And once BOTH scopes are published the generator refuses again: the guard
  // is "every declared scope", not "any edition at all".
  writeFileSync(
    scratch(quebecModule),
    readFileSync(scratch(quebecModule), "utf8").replace('status: "draft"', 'status: "published"'),
    "utf8",
  );
  const complete = runCopiedGenerator("CA");
  assert.equal(complete.status, 0, complete.out);
  assert.match(
    complete.out,
    /already has PUBLISHED statutory tables for 2099 \(CA \(country-wide\), CA · QC\)/,
  );
  assert.match(complete.out, /Nothing to scaffold/);
});
