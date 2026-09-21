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
 * GB declared a real scaffold when its 2025/26 and 2024/25 editions landed,
 * and was deleted from this list. DE, NL and SG are waiting for the same.
 */
const SCAFFOLDS_WITH_NO_FILES = new Set(["DE", "NL"]);

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

/**
 * Packs whose declared path carries no `{year}`, so it names ONE fixed file
 * instead of a per-year module — and the generator "never overwrites an existing
 * file", so it writes nothing, for every year, forever, and reports success.
 *
 * This is the third shape of the same failure and the most quietly durable of
 * the three, because the path resolves, the directory exists, and a census that
 * checks either would call it healthy.
 *
 * ES declares `es/rates.ts`; BR declares `BR_RATES_MODULE`, which is
 * `br/tax-year-2026.ts` — the CURRENT year, hardcoded. Both are the pack's
 * `ratesModule` pointer reused as a scaffold target, which is a category error:
 * `ratesModule` says where the pack's rates live so a refusal can name it, while
 * a scaffold path says where next year's module should be WRITTEN. Both packs
 * were found by shards noticing the dry run created nothing and reporting it
 * instead of treating the generator as broken.
 */
const SCAFFOLD_PATHS_WITHOUT_A_YEAR = new Set(["ES", "BR"]);

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

test("every declared scaffold file names a PER-YEAR module, not one fixed file", () => {
  // The generator never overwrites an existing file. So a path with no `{year}`
  // names one file that either already exists — in which case the generator
  // writes nothing, forever, and reports success — or gets written once and then
  // blocks every later year. The path resolves and its directory exists, so
  // neither of the other two checks in this file can see it.
  const yearless: { country: string; path: string }[] = [];
  for (const declared of declaredPayrollTaxYears()) {
    for (const file of declared.scaffold?.files ?? []) {
      if (!file.path.includes("{year}")) {
        yearless.push({ country: declared.country, path: file.path });
      }
    }
  }
  const offenders = [...new Set(yearless.map((entry) => entry.country))];
  for (const country of SCAFFOLD_PATHS_WITHOUT_A_YEAR) {
    assert.ok(
      offenders.includes(country),
      `${country} is allow-listed for a scaffold path with no {year} but all of its paths now carry `
      + "one — delete it from SCAFFOLD_PATHS_WITHOUT_A_YEAR; the list may only shrink",
    );
  }
  assert.deepEqual(
    yearless.filter((entry) => !SCAFFOLD_PATHS_WITHOUT_A_YEAR.has(entry.country)),
    [],
    "a scaffold path without {year} cannot scaffold a year: the generator refuses to overwrite the "
    + "one file it names and reports success having written nothing",
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
