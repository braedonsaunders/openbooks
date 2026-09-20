import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { declaredPayrollTaxYears } from "./packs.ts";

/**
 * Every pack's ROLLOVER SCAFFOLD DECLARATION, checked against the tree it claims
 * to write into.
 *
 * `tax-year-scaffold.test.ts` proves the generator honours a declaration. This
 * file proves the declaration is worth honouring, which is a different question
 * and was answered wrongly for five of the fourteen packs.
 *
 * Both failures below were found while staffing the prior-year campaign, and
 * both are the same shape: a declaration that satisfies the TYPE and describes
 * nothing real. `scaffold` is a required field on `PayrollTaxYearSupport`, so
 * "every pack declares a scaffold" is true and means almost nothing — four packs
 * declare `files: []`, which generates no year module, no conformance stub and no
 * barrel, and one declares a path under a directory that does not exist. In both
 * cases the generator runs, reports success, and the operator's next payroll year
 * is no closer to existing.
 *
 * The cost is paid by whoever is told the skeleton will be written for them. It
 * was paid twice in one afternoon: two shards were briefed that the generator
 * would scaffold their pack, and Italy's shard ran it, watched it aim at
 * `engine/src/payroll/it/editions/{year}.ts` — a directory no pack in this
 * repository has — and correctly wrote its edition by hand instead.
 *
 * ALLOW-LISTS THAT MAY ONLY SHRINK. A guard that goes red for a third of the
 * packs on the day it lands gets deleted, so the known-bad packs are named with
 * their reason and every OTHER pack is held to the rule from now on. Each list
 * also asserts its own members are STILL FAILING, so fixing a pack forces its
 * removal rather than leaving a stale exemption that quietly protects the next
 * regression.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Packs whose scaffold declares no files: the generator prints their `steps` and
 * writes nothing, so their next tax year is a hand transcription.
 *
 * GB is the proof this is fixable per pack rather than a missing mechanism — its
 * prior-year shard wrote its editions by hand and then declared a real scaffold,
 * so the next person gets the skeleton. DE, NL and SG are waiting for the same.
 */
const SCAFFOLDS_WITH_NO_FILES = new Set(["GB", "DE", "NL", "SG"]);

/**
 * Packs whose declared path does not live in a directory that exists.
 *
 * IT aims at `it/editions/{year}.ts`; the pack's real year modules are
 * `it/tax-year-{year}.ts` and nothing in the repository imports an `editions/`
 * subdirectory. Its template's export name (`IT_EDITION_{year}`) matches nothing
 * either, while its own step 6 tells the human to add an `IT_<year>_TABLES`
 * module by hand — so the fix is to make the declaration generate the real
 * module, not merely to repoint the path, and it needs the pack's own knowledge.
 */
const SCAFFOLD_PATHS_IN_MISSING_DIRECTORIES = new Set(["IT"]);

test("every pack's rollover scaffold declares at least one file to generate", () => {
  const empty: string[] = [];
  for (const declared of declaredPayrollTaxYears()) {
    const files = declared.scaffold?.files ?? [];
    if (files.length === 0) empty.push(declared.country);
  }
  for (const country of SCAFFOLDS_WITH_NO_FILES) {
    assert.ok(
      empty.includes(country),
      `${country} is allow-listed as declaring no scaffold files but now declares some — `
      + "delete it from SCAFFOLDS_WITH_NO_FILES; the list may only shrink",
    );
  }
  assert.deepEqual(
    empty.filter((country) => !SCAFFOLDS_WITH_NO_FILES.has(country)),
    [],
    "a pack whose scaffold declares no files cannot scaffold anything: the generator prints its "
    + "steps, writes no year module, no conformance stub and no barrel, and reports success",
  );
});

test("every declared scaffold path lives in a directory that exists", () => {
  const missing: { country: string; path: string; directory: string }[] = [];
  for (const declared of declaredPayrollTaxYears()) {
    for (const file of declared.scaffold?.files ?? []) {
      // The year is substituted at generation time; the DIRECTORY is not, so it
      // is checkable today without generating anything.
      const directory = dirname(resolve(REPO_ROOT, file.path));
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        missing.push({ country: declared.country, path: file.path, directory });
      }
    }
    for (const barrel of declared.scaffold?.barrels ?? []) {
      const directory = dirname(resolve(REPO_ROOT, barrel.path));
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        missing.push({ country: declared.country, path: barrel.path, directory });
      }
    }
  }
  const offenders = [...new Set(missing.map((entry) => entry.country))];
  for (const country of SCAFFOLD_PATHS_IN_MISSING_DIRECTORIES) {
    assert.ok(
      offenders.includes(country),
      `${country} is allow-listed for a scaffold path in a missing directory but all of its paths `
      + "now resolve — delete it from SCAFFOLD_PATHS_IN_MISSING_DIRECTORIES; the list may only shrink",
    );
  }
  assert.deepEqual(
    missing.filter((entry) => !SCAFFOLD_PATHS_IN_MISSING_DIRECTORIES.has(entry.country)),
    [],
    "a scaffold path under a directory that does not exist writes a module nothing imports",
  );
});

test("a declared barrel names the module pattern it rewrites itself from", () => {
  // A barrel is regenerated from the year modules found on disk, so a pattern
  // that cannot match the sibling file template silently produces an EMPTY
  // barrel — every transcribed year wired to nothing, with no error anywhere.
  for (const declared of declaredPayrollTaxYears()) {
    for (const barrel of declared.scaffold?.barrels ?? []) {
      assert.ok(
        barrel.modulePattern.length > 0,
        `${declared.country}: barrel ${barrel.path} declares an empty module pattern`,
      );
      const pattern = new RegExp(barrel.modulePattern);
      const sampleYear = 2026;
      const matchesSomeDeclaredFile = (declared.scaffold?.files ?? []).some((file) => {
        const filename = file.path.replace(/\{year\}/g, String(sampleYear)).split("/").pop() ?? "";
        return pattern.test(filename);
      });
      assert.ok(
        matchesSomeDeclaredFile,
        `${declared.country}: barrel ${barrel.path} has a module pattern (${barrel.modulePattern}) `
        + "that matches none of the files the same scaffold generates, so it would be rewritten empty",
      );
    }
  }
});
