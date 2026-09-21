import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const dir = import.meta.dirname;

function handlerSource(file: string, start: string, end?: string): string {
  const src = readFileSync(join(dir, file), "utf8");
  const from = src.indexOf(start);
  assert.ok(from >= 0, `${file} must export ${start}`);
  const to = end ? src.indexOf(end, from + 1) : src.length;
  assert.ok(to > from, `${file} must contain the ${start} handler`);
  return src.slice(from, to);
}

/**
 * A truthy non-array allowedRoles (e.g. `{admin:true}`) persisted as jsonb
 * makes resolveFormLayout throw on `.some`. The write must refuse by name
 * and persist only UUID role ids or null — before JSON.stringify.
 */
function assertAllowedRolesWriteGuard(source: string, label: string) {
  const persist = source.indexOf("JSON.stringify(body.allowedRoles)");
  assert.ok(persist >= 0, `${label} must persist allowedRoles as jsonb text`);
  const before = source.slice(0, persist);
  assert.match(
    before,
    /Array\.isArray\(\s*body\.allowedRoles\s*\)/,
    `${label} must type-check allowedRoles before persist`,
  );
  assert.match(
    before,
    /isUuid\(/,
    `${label} must require UUID role ids before persist`,
  );
  assert.match(
    before,
    /status:\s*400/,
    `${label} must refuse invalid allowedRoles with 400`,
  );
  assert.match(
    source,
    /allowedRoles must be a list of UUID role ids/,
    `${label} must refuse by name`,
  );
}

test("form-layouts POST and PATCH refuse non-UUID allowedRoles before persist", () => {
  assertAllowedRolesWriteGuard(
    handlerSource("route.ts", "export async function POST"),
    "POST",
  );
  assertAllowedRolesWriteGuard(
    handlerSource("[id]/route.ts", "export async function PATCH", "export async function DELETE"),
    "PATCH",
  );
});
