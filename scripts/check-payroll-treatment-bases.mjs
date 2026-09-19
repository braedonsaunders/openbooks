import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./check-test-mock-surface.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// assessedOn: "taxable_income" is an ENFORCED contract, not a comment. A
// pack that declares an income-tax component whose engine never consumes a
// treatment-driven reduction withholds the wrong money in silence — the AU
// salary-sacrifice defect (PAYG stuck while SG moved correctly) reached a
// persona exactly because nothing checked the pack's own comment. This gate
// checks it statically: every pack directory with a `taxable_income`
// component must show a consumption marker (`deduction("…"`, the legacy
// channel, or `reducedBases`, the generic channel) in its own engine
// sources, or carry an allowlist entry WITH a reason.
//
// Allowlist convention (shared with the six check-test-* guards): an entry
// is `directory: reason`. A reasonless entry fails; an entry for a pack
// that now consumes fails as stale — the allowlist tracks known gaps, so a
// closed gap must leave it, not linger as a blanket exemption.
export const TREATMENT_ALLOWLIST = {
  // Each engine prices its income tax off gross; no pre-tax treatment is
  // transcribed, and each declares an empty deductionTreatments vocabulary.
  br: "IRRF prices off gross — no pre-tax treatment transcribed",
  de: "PAP prices laufende Bezuege off gross — no pre-tax treatment transcribed",
  es: "IRPF prices off gross — no pre-tax treatment transcribed",
  fr: "PAS prices off gross — no pre-tax treatment transcribed",
  it: "IRPEF prices off gross — no pre-tax treatment transcribed",
  jp: "withholding prices off gross — no pre-tax treatment transcribed",
  pl: "PIT prices off gross — no pre-tax treatment transcribed",
  nl: "loonheffing prices off gross — no pre-tax treatment transcribed",
};

const PACK_DIR = join("engine", "src", "payroll");

const declaredRe = /deductionTreatments\s*:/;
const taxableIncomeRe = /assessedOn\s*:\s*"taxable_income"/;
const legacyConsumeRe = /\bdeduction\(\s*"/;
const genericConsumeRe = /\breducedBases\b/;

function engineSources(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

export function checkPackDirectory(dir, allowlist = TREATMENT_ALLOWLIST) {
  const findings = [];
  const name = dir.split("/").pop();
  let packSrc;
  try {
    packSrc = readFileSync(join(dir, "pack.ts"), "utf8");
  } catch {
    return findings;
  }
  const pack = codeOnly(packSrc);
  if (!declaredRe.test(pack)) {
    findings.push(`${name}/pack.ts declares no deductionTreatments — silence is not a statement`);
    return findings;
  }
  if (!taxableIncomeRe.test(pack)) return findings;
  const consumed = engineSources(dir).some((path) => {
    const src = codeOnly(readFileSync(path, "utf8"));
    return legacyConsumeRe.test(src) || genericConsumeRe.test(src);
  });
  if (consumed) {
    if (Object.hasOwn(allowlist, name)) {
      findings.push(
        `${name} consumes a treatment-driven reduction but is still allowlisted — remove the stale entry`,
      );
    }
    return findings;
  }
  const reason = allowlist[name];
  if (reason === undefined) {
    findings.push(
      `${name}/pack.ts declares assessedOn "taxable_income" but no engine source consumes a `
      + `treatment-driven reduction (deduction("…") or reducedBases) — add the consumption or an allowlist reason`,
    );
  } else if (typeof reason !== "string" || reason.trim() === "") {
    findings.push(`${name} is allowlisted without a reason — allowlist entries carry a reason`);
  }
  return findings;
}

export function scanPayrollPacks(root = ROOT, allowlist = TREATMENT_ALLOWLIST) {
  const findings = [];
  const base = join(root, PACK_DIR);
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    return [`payroll pack directory ${base} is missing`];
  }
  for (const entry of entries) {
    const dir = join(base, entry);
    if (!statSync(dir).isDirectory()) continue;
    try {
      if (statSync(join(dir, "pack.ts")).isFile()) {
        findings.push(...checkPackDirectory(join(root, PACK_DIR, entry), allowlist));
      }
    } catch {
      continue;
    }
  }
  for (const name of Object.keys(allowlist)) {
    if (!entries.includes(name)) {
      findings.push(`allowlist entry "${name}" names no payroll pack directory — remove it`);
    }
  }
  return findings;
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  const findings = scanPayrollPacks();
  if (findings.length > 0) {
    for (const finding of findings) console.error(`check-payroll-treatment-bases: ${finding}`);
    process.exit(1);
  }
  console.log("check-payroll-treatment-bases: every taxable_income component consumes a treatment-driven reduction");
}
