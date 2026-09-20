import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { refuseInactivePromotedDefault } from "./promote.ts";

const source = readFileSync(new URL("./promote.ts", import.meta.url), "utf8");

function applyChangeSetBody(src: string): string {
  const start = src.indexOf("export async function applyChangeSet");
  assert.notEqual(start, -1, "applyChangeSet must exist");
  const next = src.indexOf("\nexport async function", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

test("applyChangeSet refuses an inactive default before jsonb_populate_record", () => {
  const body = applyChangeSetBody(source);
  const refuseAt = body.indexOf("refuseInactivePromotedDefault(");
  const writeAt = body.indexOf("jsonb_populate_record");
  assert.notEqual(refuseAt, -1, "applyChangeSet must call refuseInactivePromotedDefault");
  assert.notEqual(writeAt, -1, "applyChangeSet must still write via jsonb_populate_record");
  assert.ok(refuseAt < writeAt, "the refusal must run before the generic populate write");
});

test("inactive default refusal names form and view apart and names both remedies", () => {
  const VIEW = /inactive view cannot be the default/i;
  const FORM = /inactive form cannot be the default/i;
  const ACTIVATE = /activate it/i;
  const UNSET = /unset default before deactivating/i;
  const RECAPTURE = /recapture the change set/i;

  for (const table of ["user_scripts", "saved_views", "app_roles"]) {
    refuseInactivePromotedDefault(table, { is_default: true, is_active: false }, null);
  }

  const viewErr = (() => {
    try {
      refuseInactivePromotedDefault("list_views", { is_default: true, is_active: false }, null);
    } catch (error) {
      return error;
    }
  })();
  const formErr = (() => {
    try {
      refuseInactivePromotedDefault("form_layouts", { is_default: true, is_active: false }, null);
    } catch (error) {
      return error;
    }
  })();
  assert.ok(viewErr instanceof Error);
  assert.ok(formErr instanceof Error);
  assert.match(viewErr.message, VIEW);
  assert.match(formErr.message, FORM);
  assert.match(viewErr.message, ACTIVATE);
  assert.match(viewErr.message, UNSET);
  assert.match(viewErr.message, RECAPTURE);
  assert.match(formErr.message, ACTIVATE);
  assert.match(formErr.message, UNSET);
  assert.match(formErr.message, RECAPTURE);
  assert.notEqual(viewErr.message, formErr.message);

  for (const table of ["form_layouts", "list_views"]) {
    refuseInactivePromotedDefault(table, { is_default: true, is_active: true }, null);
    refuseInactivePromotedDefault(table, { is_default: false, is_active: false }, null);
    refuseInactivePromotedDefault(table, { is_default: false, is_active: true }, null);
  }

  assert.throws(
    () => refuseInactivePromotedDefault("list_views", { is_active: false }, { is_default: true, is_active: true }),
    VIEW,
  );
  assert.throws(
    () => refuseInactivePromotedDefault("form_layouts", { is_default: true }, { is_default: false, is_active: false }),
    FORM,
  );

  refuseInactivePromotedDefault("list_views", { is_active: true }, { is_default: true, is_active: false });
  refuseInactivePromotedDefault("form_layouts", { is_default: false, is_active: false }, { is_default: true, is_active: true });
});
