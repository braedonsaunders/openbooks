import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as ts from "typescript";
// Side effect: registers the built-in packs and publishes their
// certificate sources, the same way any production importer does.
import "./packs.ts";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import { packCertificates } from "./certificates.ts";
import {
  empFact,
  employeeFactProducerProblem,
  employeeFactsFor,
  employeeFactsProblem,
  isEmployeeFactsRegistered,
  isPayrollPackPayable,
  missingEmployeeFacts,
  packPayableProblem,
  type PayrollEmployeeFact,
} from "./employee-facts.ts";

/**
 * The employee-facts conformance test. Four packs read `emp[...]` facts no
 * surface produces; this test is what stops the fifth.
 *
 * IT MUST NOT BE A GREP. The first census of this defect used `grep -rl`
 * and reported Brazil healthy off two COMMENT matches
 * (`br/certificates.ts:7`, `br/withholding.ts:8`). A test matching text
 * would certify those same comments and freeze the error as a passing
 * test. So both sets below are built from TYPED structures:
 *
 * - CONSUMED comes from the TypeScript AST: element accesses (`emp["k"]`,
 *   `ctx.emp["k"]`), property accesses (`emp.k`) and `empFact(cc, emp,
 *   "k")` calls on the employee record. Comments, refusal-message
 *   strings and refusal-code lists (br/tax-year-2026.ts:151) are never
 *   AST reads, so they can never satisfy it.
 * - PRODUCERS are validated against the typed registries — the
 *   certificate declarations, the profile-column mappings, the exemption
 *   flags, the Drizzle table — never against occurrences of the key.
 *
 * Equality is asserted BOTH ways per pack: every consumed fact is
 * declared, and every declared fact is consumed (a declared fact nobody
 * reads is how a list starts describing an imaginary product).
 */

const FOURTEEN = [
  "CA", "US", "GB", "DE", "FR", "IE",
  "AU", "IT", "NL", "ES", "SG", "JP", "PL", "BR",
];

interface ConsumedRead {
  key: string;
  /** The country literal on an `empFact(cc, …)` call; null for raw reads. */
  countryArg: string | null;
}

function consumedInSourceText(sourceText: string): ConsumedRead[] {
  const found: ConsumedRead[] = [];
  const source = ts.createSourceFile("pack-scan.ts", sourceText, ts.ScriptTarget.Latest, true);
  const onEmployeeRecord = (target: ts.Expression): boolean =>
    (ts.isIdentifier(target) && target.text === "emp")
    || (ts.isPropertyAccessExpression(target) && target.name.text === "emp");
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (
        onEmployeeRecord(node.expression)
        && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        found.push({ key: arg.text, countryArg: null });
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      if (onEmployeeRecord(node.expression)) {
        found.push({ key: node.name.text, countryArg: null });
      }
    } else if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression)
        && node.expression.text === "empFact"
        && node.arguments.length === 3
      ) {
        const countryNode = node.arguments[0];
        const keyNode = node.arguments[2];
        if (
          countryNode !== undefined && keyNode !== undefined
          && ts.isStringLiteral(countryNode) && ts.isStringLiteral(keyNode)
        ) {
          found.push({ key: keyNode.text, countryArg: countryNode.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Registry country → pack directory (Canada's is `canada/`, not `ca/`). */
const PACK_DIRS: Record<string, string> = {
  CA: "canada", US: "us", GB: "gb", DE: "de", FR: "fr", IE: "ie",
  AU: "au", IT: "it", NL: "nl", ES: "es", SG: "sg", JP: "jp", PL: "pl", BR: "br",
};

/** Every employee-record read in one pack's non-test sources. */
function consumedEmployeeFacts(country: string): { keys: string[]; reads: ConsumedRead[] } {
  const dir = fileURLToPath(new URL(`./${PACK_DIRS[country]}/`, import.meta.url));
  const files = readdirSync(dir).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  const reads: ConsumedRead[] = [];
  for (const file of files) {
    reads.push(...consumedInSourceText(readFileSync(`${dir}${file}`, "utf8")));
  }
  return { keys: [...new Set(reads.map((read) => read.key))].sort(), reads };
}

function declaredKeys(country: string): string[] {
  return [...(PAYROLL_COUNTRY_PACKS[country]?.employeeFacts ?? []).map((fact) => fact.key)].sort();
}

test("the registry holds exactly the fourteen packs this test pins", () => {
  assert.deepEqual([...Object.keys(PAYROLL_COUNTRY_PACKS)].sort(), [...FOURTEEN].sort());
});

test("every pack with reads has its facts module registered", () => {
  // Registration is what `empFact` resolves through at runtime: it happens
  // in the pack's own `<country>/employee-facts.ts`, imported by both the
  // pack literal and the compute path. A pack that reads nothing registers
  // nothing and is honestly empty.
  for (const country of ["CA", "US", "ES", "JP", "PL", "BR"]) {
    assert.ok(isEmployeeFactsRegistered(country), `${country} facts are registered`);
  }
  assert.deepEqual(employeeFactsFor("GB"), []);
});

for (const country of FOURTEEN) {
  test(`${country}: every consumed employee fact is declared, and every declared fact is consumed`, () => {
    const consumed = consumedEmployeeFacts(country);
    // No pack reads another pack's record through the declaration: the
    // country literal on every empFact call is the pack's own.
    for (const read of consumed.reads) {
      assert.equal(
        read.countryArg ?? country, country,
        `${country} reads "${read.key}" under country ${read.countryArg ?? "(raw)"}`,
      );
    }
    assert.deepEqual(
      consumed.keys, declaredKeys(country),
      `${country}: consumed ${JSON.stringify(consumed.keys)} vs declared ${JSON.stringify(declaredKeys(country))}`,
    );
  });

  test(`${country}: the declaration is structurally sound and every producer resolves`, () => {
    const pack = PAYROLL_COUNTRY_PACKS[country];
    assert.ok(pack, `${country} is registered`);
    assert.equal(
      employeeFactsProblem(
        country,
        pack.employeeFacts,
        (pack.profileExemptionFlags ?? []).map((flag) => flag.column),
      ),
      null,
    );
  });
}

test("payable is derived: all fourteen packs payable once every required fact has a producer", () => {
  // 0191 built the seven blocking producers (plus the BR pensão column, so
  // the deduction is enterable): every required fact in every pack now
  // resolves, so `payable` derives true everywhere. If a future pack
  // declares a required fact with no producer, this flips back to false
  // for it — that is the derivation working, not this test rotting.
  const expectedPayable: Record<string, boolean> = {
    CA: true, US: true, GB: true, DE: true, FR: true, IE: true,
    AU: true, IT: true, NL: true, ES: true, SG: true, JP: true, PL: true, BR: true,
  };
  const packOf = (country: string) => {
    const pack = PAYROLL_COUNTRY_PACKS[country];
    assert.ok(pack, `${country} is registered`);
    return pack;
  };
  for (const country of FOURTEEN) {
    const pack = packOf(country);
    assert.equal(isPayrollPackPayable(pack), expectedPayable[country], `${country} payable`);
    const problem = packPayableProblem(pack);
    if (expectedPayable[country]) {
      assert.equal(problem, null, `${country} has no payable problem`);
    } else {
      assert.ok(problem, `${country} names why it cannot pay`);
    }
  }
  // The derivation still names blockers by key when they exist — and still
  // ignores optional vacancies: prove both against a synthetic pack-shaped
  // declaration rather than by wishing a real pack unpayable again.
  const syntheticProblem = packPayableProblem({
    ...packOf("PL"),
    employeeFacts: [
      {
        key: "pl_rok_urodzenia", kind: "year", label: "Birth year (rok urodzenia)",
        refusalReason: "Fixture.", required: true,
        producer: { kind: "none", notes: "Fixture: no producer." },
      },
      {
        key: "zz_optional", kind: "flag", label: "Fixture optional",
        refusalReason: "Fixture.", required: false,
        producer: { kind: "none", notes: "Fixture: no producer." },
      },
    ],
  }) ?? "";
  assert.match(syntheticProblem, /pl_rok_urodzenia/);
  assert.doesNotMatch(syntheticProblem, /zz_optional/);
});

test("missingEmployeeFacts lists required-but-absent facts, never optional ones", () => {
  // PL blocks on an absent birth year; ES accepts an absent contrato flag.
  assert.deepEqual(
    missingEmployeeFacts("PL", {}).map((fact) => fact.key),
    ["pl_rok_urodzenia"],
  );
  assert.deepEqual(missingEmployeeFacts("PL", { pl_rok_urodzenia: "1990" }), []);
  assert.deepEqual(missingEmployeeFacts("PL", { pl_rok_urodzenia: "" }).map((fact) => fact.key), [
    "pl_rok_urodzenia",
  ]);
  assert.deepEqual(
    missingEmployeeFacts("ES", {
      es_situacion_laboral: "activo",
      es_grupo_cotizacion: "3",
      es_ano_nacimiento: "1990",
    }).map((fact) => fact.key),
    [],
    "an absent optional contrato temporal is never missing",
  );
});

test("Brazil's prose is not a producer: one explicit non-form declaration, typed producers", () => {
  // The exact trap the grep census fell into: two files MENTION the facts
  // in comments (`br/certificates.ts`, `br/withholding.ts`), and mentions
  // satisfy nothing — only the typed declaration below does. Since 0191 the
  // pack declares exactly one certificate, and it is explicitly NOT an
  // employee-filed form: the eSocial cadastre facts made explicit, because
  // the profile-column channel validates against the typed declarations and
  // a column no certificate field maps is not a producer.
  const certificates = packCertificates("BR").certificates;
  assert.equal(certificates.length, 1, "Brazil declares exactly its cadastre facts, no invented form");
  assert.equal(certificates[0]?.key, "br_cadastro");
  assert.equal(certificates[0]?.storage, "profile_columns");
  const producers = (PAYROLL_COUNTRY_PACKS["BR"]?.employeeFacts ?? []).map(
    (fact) => `${fact.key}:${fact.producer.kind}`,
  );
  assert.deepEqual(producers, [
    "br_dependentes:profile_column",
    "br_pensao_mensal:profile_column",
    "br_regime:none",
  ]);
});

// ---------------------------------------------------------------------------
// Instrument validation: the extractor and the producer check must each be
// shown firing in BOTH directions before the assertions above are trusted.
// An extractor that returns everything also "finds" the known case, so the
// negative controls are the load-bearing half.
// ---------------------------------------------------------------------------

test("instrument: the extractor finds a known consumption", () => {
  assert.ok(consumedEmployeeFacts("PL").keys.includes("pl_rok_urodzenia"));
  assert.ok(consumedEmployeeFacts("US").keys.includes("filing_status"));
});

test("instrument: the extractor refuses an invented name nothing consumes", () => {
  for (const country of FOURTEEN) {
    assert.ok(
      !consumedEmployeeFacts(country).keys.includes(`${country.toLowerCase()}_invented_fact`),
      `${country} must not consume an invented fact`,
    );
  }
});

test("instrument: comments and prose never count as consumption", () => {
  // br/certificates.ts:7 and br/withholding.ts:8 mention the keys in
  // comments; br/tax-year-2026.ts:151 carries one inside a refusal string.
  // The same shapes must yield nothing here.
  const reads = consumedInSourceText(
    `// emp["zz_comment_fact"]\n`
    + `// empFact("ZZ", emp, "zz_comment_call")\n`
    + `const label = "refused via zz_string_fact";\n`
    + `const keys = ["zz_array_fact"];\n`
    + `const ok = 1;\n`,
  );
  assert.deepEqual(reads, []);
});

test("instrument: a claimed producer that resolves nowhere is refused by name", () => {
  const base: PayrollEmployeeFact = {
    key: "zz_fact", kind: "flag", label: "Fixture", refusalReason: "Fixture.",
    required: true, producer: { kind: "none", notes: "Fixture." },
  };
  const badCertificate: PayrollEmployeeFact = {
    ...base,
    producer: { kind: "certificate", certificate: "es_145", field: "no_such_field" },
  };
  assert.match(
    employeeFactProducerProblem("ES", badCertificate) ?? "", /no_such_field/,
    "an undeclared certificate field must be refused naming the field",
  );
  const badColumn: PayrollEmployeeFact = {
    ...base,
    producer: { kind: "profile_column", column: "no_such_column" },
  };
  assert.match(
    employeeFactProducerProblem("PL", badColumn) ?? "", /no_such_column/,
    "an unmapped profile column must be refused naming the column",
  );
  const badFlag: PayrollEmployeeFact = {
    ...base,
    producer: { kind: "exemption_flag", column: "no_such_flag" },
  };
  assert.match(
    employeeFactProducerProblem("US", badFlag) ?? "", /no_such_flag/,
    "an undeclared exemption flag must be refused naming the column",
  );
  const badBase: PayrollEmployeeFact = {
    ...base,
    producer: { kind: "base_column", column: "no_such_base_column" },
  };
  assert.match(
    employeeFactProducerProblem("US", badBase) ?? "", /no_such_base_column/,
    "a missing base column must be refused naming the column",
  );
});

test("instrument: reading through the declaration refuses an undeclared key", () => {
  assert.throws(
    () => empFact("PL", {}, "pl_undeclared_key"),
    /without declaring it/,
  );
  // ...and a country with no registered declaration refuses before any key
  // is even considered — silence can never smuggle a read past it.
  assert.throws(
    () => empFact("ZZ", {}, "zz_anything"),
    /no employeeFacts registered for ZZ/,
  );
  // ...while a declared key passes the raw value through untouched.
  assert.equal(empFact("PL", { pl_rok_urodzenia: "1990" }, "pl_rok_urodzenia"), "1990");
  assert.equal(empFact("PL", {}, "pl_rok_urodzenia"), undefined);
});
