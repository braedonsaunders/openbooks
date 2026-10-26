import assert from "node:assert/strict";
import test from "node:test";
import { provisionDrawerLinks } from "./drawer-links";

test("provision drawers retain list context and close an assessment back to its obligation", () => {
  const links = provisionDrawerLinks({ q: "lease", page: "3", provision: "obligation-id" });
  const create = new URL(links.newHref, "http://openbooks.test");
  assert.equal(create.searchParams.get("q"), "lease");
  assert.equal(create.searchParams.get("page"), "3");
  assert.equal(create.searchParams.get("provision"), "new");

  const assessment = new URL(links.assessmentOpenHref, "http://openbooks.test");
  assert.equal(assessment.searchParams.get("provision"), "obligation-id");
  assert.equal(assessment.searchParams.get("assess"), "1");
  const closed = new URL(links.assessmentCloseHref, "http://openbooks.test");
  assert.equal(closed.searchParams.get("provision"), "obligation-id");
  assert.equal(closed.searchParams.has("assess"), false);
});
