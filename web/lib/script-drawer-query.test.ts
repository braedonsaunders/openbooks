import assert from "node:assert/strict";
import test from "node:test";
import { scriptDrawerQueryId, scriptTriggerMessageKey } from "./script-drawer-query";

test("script drawer queries only accept UUID ids", () => {
  assert.equal(scriptDrawerQueryId("not-a-uuid"), null);
  assert.equal(scriptDrawerQueryId("new"), null);
  assert.equal(scriptDrawerQueryId(undefined), null);
  assert.equal(
    scriptDrawerQueryId("2e630934-70b3-4ae9-bcfb-5c6dff2e970c"),
    "2e630934-70b3-4ae9-bcfb-5c6dff2e970c",
  );
});

test("custom GL line triggers use their translated message key", () => {
  assert.equal(scriptTriggerMessageKey("custom_gl_lines"), "customGlLines");
});
