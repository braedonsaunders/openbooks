/**
 * Scaffold the next tax year's statutory tables for a payroll country pack.
 *
 *   npx tsx scripts/payroll-new-tax-year.ts --country CA --year 2027
 *   npx tsx scripts/payroll-new-tax-year.ts --country US --year 2027 --dry-run
 *   npx tsx scripts/payroll-new-tax-year.ts --list
 *   npx tsx scripts/payroll-new-tax-year.ts --country US --year 2099 --root /path/to/copy
 *
 * The annual rollover is the one payroll ritual with a hard deadline and no
 * room for improvisation: every statutory engine in this repository REFUSES a
 * pay date outside the years it has transcribed, which is correct, and until now
 * left the January payroll blocked with no path from "refused" to "loaded"
 * except reading three modules and copying their shape by hand.
 *
 * This generator writes that path FROM THE PACK'S OWN DECLARATION
 * (`PayrollTaxYearSupport.scaffold` in engine/src/payroll/{us,canada}/rates.ts):
 *
 *   1. a year module per publication the year needs, every figure set to the
 *      UNFILLED sentinel — so it type-checks, `ratesForPayDate` refuses it as a
 *      DRAFT by name, and nothing can withhold from it;
 *   2. a conformance stub per publication that FAILS until every placeholder is
 *      gone and real published goldens are pasted in;
 *   3. the generated editions barrel, rewritten from the year modules on disk,
 *      so the new year is wired without editing a hand-maintained list.
 *
 * The generator knows no jurisdiction: it substitutes {year} and {priorYear} into
 * declared templates and rewrites declared barrels. A pack that declares its own
 * scaffold gets this for free; a pack that declares none is refused by name.
 *
 * It never overwrites an existing file. Re-running after a partial rollover
 * reports what is already there and regenerates only the barrels — including
 * the partial rollover a country with regions publishing their own tables
 * spends a month in every year: the CRA's T4127 transcribed and published while
 * Revenu Québec's TP-1015 for the same year is not out yet still scaffolds the
 * Quebec half, because "published" is per SCOPE, not per year.
 *
 * Every declared path is repo-relative, and `--root` says which repo they are
 * relative TO. It defaults to this checkout — writing a real edition into the
 * real tree is the generator's job — and exists so a test can drive the whole
 * generator against a throwaway copy of the sources instead of mutating
 * checked-in files that sibling test files are importing at the same time.
 * Nothing else changes: the declarations are always read from this checkout,
 * and every path printed stays repo-relative.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  declaredPayrollTaxYears,
  payrollTaxYearSupport,
  type PayrollEditionScaffold,
  type PayrollTaxYearSupport,
} from "../engine/src/payroll/tax-years.ts";

/** This checkout — where a real rollover writes, and the `--root` default. */
const REPO_ROOT = resolve(import.meta.dirname, "..");

interface Options {
  country: string | null;
  year: number | null;
  dryRun: boolean;
  list: boolean;
  /** Root the declared repo-relative paths are written under. */
  root: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    country: null, year: null, dryRun: false, list: false, root: REPO_ROOT,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = (): string => {
      const inline = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
      if (!inline) throw new Error(`${arg} needs a value`);
      return inline;
    };
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--list") options.list = true;
    else if (arg.startsWith("--country")) options.country = value().toUpperCase();
    else if (arg.startsWith("--year")) options.year = Number(value());
    else if (arg.startsWith("--root")) options.root = resolve(process.cwd(), value());
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

/** `{year}` / `{priorYear}` substitution — the only templating there is. */
function fill(template: string, year: number): string {
  return template
    .replaceAll("{year}", String(year))
    .replaceAll("{priorYear}", String(year - 1));
}

interface Written {
  path: string;
  purpose: string;
  skipped: boolean;
}

function writeScaffoldFiles(
  scaffold: PayrollEditionScaffold,
  year: number,
  dryRun: boolean,
  root: string,
): Written[] {
  const written: Written[] = [];
  for (const file of scaffold.files) {
    const relative = fill(file.path, year);
    const absolute = join(root, relative);
    if (existsSync(absolute)) {
      written.push({ path: relative, purpose: file.purpose, skipped: true });
      continue;
    }
    if (!dryRun) {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, fill(file.template, year), "utf8");
    }
    written.push({ path: relative, purpose: fill(file.purpose, year), skipped: false });
  }
  return written;
}

/**
 * Rewrite a barrel from the year modules PRESENT ON DISK. The barrel is fully
 * generated, so this is idempotent and cannot drift from the directory: exactly
 * the property a hand-maintained editions list does not have.
 */
function rewriteBarrel(
  barrel: PayrollEditionScaffold["barrels"][number],
  dryRun: boolean,
  root: string,
): { path: string; years: number[] } {
  const absolute = join(root, barrel.path);
  const directory = dirname(absolute);
  const pattern = new RegExp(barrel.modulePattern);
  const years: number[] = [];
  for (const entry of existsSync(directory) ? readdirSync(directory) : []) {
    const match = pattern.exec(entry);
    if (match?.[1]) years.push(Number(match[1]));
  }
  years.sort((a, b) => a - b);
  const imports = years
    .map((year) => {
      const name = fill(barrel.exportName, year);
      return `import { ${name} } from "./rates-${year}.ts";\n`;
    })
    .join("");
  const entries = years.length === 0
    ? ""
    : `\n${years.map((year) => `  ${fill(barrel.exportName, year)},`).join("\n")}\n`;
  const body = barrel.template
    .replace("{imports}", imports)
    .replace("{entries}", entries);
  if (!dryRun) writeFileSync(absolute, body, "utf8");
  return { path: barrel.path, years };
}

/** One publication scope a year needs before the pack's tables are loaded. */
interface Scope {
  label: string;
  published: boolean;
}

/**
 * Every scope the year must be PUBLISHED for: the country-wide publication,
 * plus each region that publishes its own (`regionsWithOwnTables` — Revenu
 * Québec's TP-1015 beside the CRA's T4127).
 *
 * Asking only about the country-wide edition would call a CA year finished the
 * moment the T4127 landed. Quebec's guide lagging the CRA's by a month is a
 * real state the pack models on purpose (engine/src/payroll/tax-years.ts), and
 * it is precisely the state in which somebody needs the QC skeleton generated —
 * so a guard that reads only the country-wide edition locks the generator out
 * of the one job left to do.
 */
function declaredScopes(support: PayrollTaxYearSupport, year: number): Scope[] {
  const publishedFor = (region: string | null): boolean =>
    support.editions.some((edition) =>
      edition.year === year
      && edition.status === "published"
      && (edition.region ?? null) === region);
  return [
    { label: `${support.country} (country-wide)`, published: publishedFor(null) },
    ...support.regionsWithOwnTables.map((region) => ({
      label: `${support.country} · ${region}`,
      published: publishedFor(region),
    })),
  ];
}

function describe(support: PayrollTaxYearSupport): string {
  const published = support.editions
    .filter((edition) => edition.status === "published")
    .map((edition) => `${edition.year} ${edition.label}${edition.region ? ` [${edition.region}]` : ""}`);
  const draft = support.editions
    .filter((edition) => edition.status === "draft")
    .map((edition) => `${edition.year} ${edition.label}${edition.region ? ` [${edition.region}]` : ""}`);
  return [
    `${support.country}: ${support.ratesModule}`,
    `  published: ${published.join(", ") || "none"}`,
    `  draft:     ${draft.join(", ") || "none"}`,
    support.regionsWithOwnTables.length > 0
      ? `  regions publishing their own tables: ${support.regionsWithOwnTables.join(", ")}`
      : "  no region publishes its own tables",
  ].join("\n");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.list || (!options.country && !options.year)) {
    console.log("Payroll packs and the tax years their statutory tables are loaded for:\n");
    for (const support of declaredPayrollTaxYears()) console.log(`${describe(support)}\n`);
    console.log("Scaffold the next year:\n  npx tsx scripts/payroll-new-tax-year.ts --country CA --year 2027");
    return;
  }
  if (!options.country) throw new Error("--country is required (e.g. --country CA)");
  if (!options.year || !Number.isInteger(options.year) || options.year < 2000 || options.year > 2100) {
    throw new Error("--year must be a tax year (e.g. --year 2027)");
  }

  // Refuses an undeclared pack by name, listing the ones that do declare.
  const support = payrollTaxYearSupport(options.country);
  const { year, dryRun, root } = { year: options.year, dryRun: options.dryRun, root: options.root };
  if (!existsSync(root)) throw new Error(`--root ${root} does not exist`);

  // Refuse only when EVERY declared scope for the year is published. A year
  // published for one scope and missing for another is a partial rollover, and
  // the remaining scope is exactly what the generator is for.
  const scopes = declaredScopes(support, year);
  const publishedScopes = scopes.filter((scope) => scope.published);
  const missingScopes = scopes.filter((scope) => !scope.published);
  const list = (of: Scope[]): string => of.map((scope) => scope.label).join(", ");
  if (missingScopes.length === 0) {
    console.log(
      `${options.country} already has PUBLISHED statutory tables for ${year}`
      + `${scopes.length > 1 ? ` (${list(scopes)})` : ""}. Nothing to scaffold — `
      + "a published edition is never overwritten by a generator.",
    );
    return;
  }

  console.log(
    `Scaffolding ${options.country} ${year}${dryRun ? " (dry run)" : ""}`
    + `${root === REPO_ROOT ? "" : ` under ${root}`}\n`,
  );
  if (publishedScopes.length > 0) {
    // The published scope's own year module is already on disk, so the
    // `existsSync` skip below leaves it untouched — the promise holds.
    console.log(
      `  ${year} is already PUBLISHED for ${list(publishedScopes)} and still missing for `
      + `${list(missingScopes)}. Only the files that do not exist are written.\n`,
    );
  }
  const files = writeScaffoldFiles(support.scaffold, year, dryRun, root);
  for (const file of files) {
    console.log(`  ${file.skipped ? "exists  " : "created "} ${file.path}`);
    if (!file.skipped) console.log(`            ${file.purpose}`);
  }

  console.log("");
  for (const barrel of support.scaffold.barrels) {
    const { path, years } = rewriteBarrel(barrel, dryRun, root);
    console.log(`  ${dryRun ? "would wire" : "wired   "} ${path} → ${years.join(", ") || "no year modules"}`);
  }

  console.log(`\nNext, in order:`);
  support.scaffold.steps.forEach((step, index) => {
    console.log(`  ${index + 1}. ${fill(step, year)}`);
  });
  console.log(
    `\nUntil then the ${year} edition is a DRAFT: every statutory engine refuses it by name, the `
    + `pay-run pre-flight blocks a ${year} run, and the generated conformance stubs fail.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
