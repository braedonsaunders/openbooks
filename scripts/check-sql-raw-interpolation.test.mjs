import assert from "node:assert/strict";
import test from "node:test";
import {
  checkTree,
  scanSource,
} from "./check-sql-raw-interpolation.mjs";

// The field-ticket import's old spelling: the CLI-controlled org id inside a
// single-quoted literal, so a quote breaks out and runs as SQL.
const VALUE_INTERPOLATION = `import { sql } from "drizzle-orm";
export async function sourceIdMap(table: string, orgId: string) {
  return db.execute(sql.raw(
    \`select id from "\${table}" where org_id = '\${orgId}'\`,
  ));
}`;

test("flags a value interpolated inside single quotes", () => {
  const findings = scanSource("engine/src/validation/sample.ts", VALUE_INTERPOLATION); // source-path: synthetic
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fn, "sourceIdMap");
  assert.match(findings[0].arg, /org_id/);
});

test("flags a quoted list built by mapping over values", () => {
  const listed = `import { sql } from "drizzle-orm";
const accountTypesSql = sql.raw(\`(\${["a", "b"].map((t) => \`'\${t}'\`).join(',')})\`);`; // source-path: synthetic
  const findings = scanSource("web/lib/sample.ts", listed); // source-path: synthetic
  assert.equal(findings.length, 1);
});

test("the refusal names the file, the function, and the remedy", () => {
  const problems = checkTree(scanSource("engine/src/validation/sample.ts", VALUE_INTERPOLATION)); // source-path: synthetic
  assert.equal(problems.length, 1);
  assert.match(problems[0], /engine\/src\/validation\/sample\.ts:\d+/); // source-path: synthetic
  assert.match(problems[0], /sourceIdMap/);
  assert.match(problems[0], /bound parameters/);
});

test("passes identifiers, constants, and bound values", () => {
  const clean = `import { sql } from "drizzle-orm";
const LEASE = sql.raw("interval '30 minutes'");
export async function lookup(table: "a" | "b", orgId: string) {
  const quoted = sql.raw(\`"\${table}"\`);
  const escaped = sql.raw(\`"\${name.replace(/"/g, '""')}"\`);
  return db.execute(sql\`select id from \${quoted} where org_id = \${orgId} and kind in \${sql.join(kinds.map((k) => sql\`\${k}\`), sql\`, \`)}}\`);
}`; // source-path: synthetic
  const findings = scanSource("engine/src/sample.ts", clean); // source-path: synthetic
  assert.deepEqual(findings, []);
});

test("flags quoted concatenation with a computed operand", () => {
  const concat = `import { sql } from "drizzle-orm";
export function scoped(kind: string) {
  return db.execute(sql.raw("select 1 where kind = '" + kind + "'"));
}`; // source-path: synthetic
  const findings = scanSource("engine/src/sample.ts", concat); // source-path: synthetic
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fn, "scoped");
});

test("passes quotes that never touch a substitution boundary", () => {
  // Identifier fragments with constant fallbacks: the quotes are SQL
  // constants mid-literal, and no value crosses a literal boundary.
  const identifiers = `import { sql } from "drizzle-orm";
export function labelCase(first: unknown, second: unknown) {
  return sql.raw(\`case when coalesce(\${first}, '') <> '' then \${first} else \${second} end\`);
}`; // source-path: synthetic
  const findings = scanSource("web/lib/sample.ts", identifiers); // source-path: synthetic
  assert.deepEqual(findings, []);
});

test("passes prose and comments mentioning the shape", () => {
  const prose = `// Never build org_id = '\${value}' with sql.raw; bind it.
const note = "sql.raw(\`'x'\`) is the forbidden shape";`; // source-path: synthetic
  const findings = scanSource("engine/src/sample.ts", prose); // source-path: synthetic
  assert.deepEqual(findings, []);
});
