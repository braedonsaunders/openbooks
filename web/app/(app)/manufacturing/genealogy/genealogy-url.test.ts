import assert from "node:assert/strict";
import test from "node:test";
import { genealogyHref } from "./genealogy-url";

test("changing trace direction preserves the selected seed and depth", () => {
  const href = genealogyHref(
    "?kind=lot&id=00000000-0000-4000-8000-000000000001&direction=forward&maxDepth=12",
    {
      direction: "backward",
    },
  );
  assert.equal(
    href,
    "/manufacturing/genealogy?kind=lot&id=00000000-0000-4000-8000-000000000001&direction=backward&maxDepth=12",
  );
});

test("changing seed kind clears the previous identity and preserves trace settings", () => {
  const href = genealogyHref(
    "?kind=lot&id=00000000-0000-4000-8000-000000000001&direction=backward&maxDepth=12",
    {
      kind: "serial",
    },
  );
  assert.equal(href, "/manufacturing/genealogy?kind=serial&direction=backward&maxDepth=12");
});

test("selecting a seed retains the direction and depth in the shareable URL", () => {
  const href = genealogyHref("?kind=serial&direction=backward&maxDepth=20", {
    id: "00000000-0000-4000-8000-000000000002",
  });
  assert.equal(
    href,
    "/manufacturing/genealogy?kind=serial&direction=backward&maxDepth=20&id=00000000-0000-4000-8000-000000000002",
  );
});
