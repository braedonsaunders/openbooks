import assert from "node:assert/strict";
import test from "node:test";
import {
  informationReturnDrawerCloseHref,
  informationReturnFilingHref,
  informationReturnsViewState,
} from "./view-state";

test("information return tabs keep list context and show readiness count only when needed", () => {
  const params = { q: "1099", page: "2", filing: "filing-id" };
  const { view, tabs } = informationReturnsViewState(params, 3, {
    filings: "Filings",
    readiness: "Readiness",
  });
  assert.equal(view, "filings");
  assert.equal(tabs[0]?.active, true);
  assert.equal(tabs[1]?.count, 3);
  assert.equal(new URL(tabs[1]!.href, "http://openbooks.test").searchParams.get("q"), "1099");
  assert.equal(tabs[1]?.href.includes("filing-id"), true);
  assert.equal(
    informationReturnsViewState({ view: "readiness" }, 0, {
      filings: "Filings",
      readiness: "Readiness",
    }).tabs[1]?.count,
    undefined,
  );
});

test("filing drawers open in the filings view and close back to the same list context", () => {
  const params = { q: "1099", page: "2", view: "filings" };
  const open = new URL(informationReturnFilingHref(params, "filing-id"), "http://openbooks.test");
  assert.equal(open.searchParams.get("filing"), "filing-id");
  assert.equal(open.searchParams.get("view"), "filings");
  assert.equal(open.searchParams.get("q"), "1099");

  const close = new URL(
    informationReturnDrawerCloseHref({ ...params, filing: "filing-id" }),
    "http://openbooks.test",
  );
  assert.equal(close.searchParams.has("filing"), false);
  assert.equal(close.searchParams.get("page"), "2");
});
