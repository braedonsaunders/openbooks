import assert from "node:assert/strict";
import test from "node:test";
import { drawerTitleKind } from "./drawer-title.ts";

/**
 * CK-23b: the open drawer is titled for its own record. The branch is pure
 * so the rule is proven here without booting Next; the translated keys the
 * loader maps each kind to are covered by the catalog, and the bodies by
 * the read-back render test.
 */
test("an open offer owns the drawer title", () => {
  assert.equal(drawerTitleKind({ hasOffer: true, hasCandidate: false }), "offer");
  assert.equal(drawerTitleKind({ hasOffer: true, hasCandidate: true }), "offer");
});

test("an open candidate owns the drawer title when no offer is open", () => {
  assert.equal(drawerTitleKind({ hasOffer: false, hasCandidate: true }), "candidate");
});

test("the requisition title is the fallback", () => {
  assert.equal(drawerTitleKind({ hasOffer: false, hasCandidate: false }), "requisition");
});
