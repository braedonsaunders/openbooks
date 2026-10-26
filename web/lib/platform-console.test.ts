import assert from "node:assert/strict";
import test from "node:test";
import { platformDrawerHref, platformUserDrawerHref } from "./platform-console";

test("platform user drawer links preserve list state and close without dropping it", () => {
  const params = {
    q: "finance ops",
    status: "active",
    page: "3",
    perPage: "50",
    user: "old-user",
  };

  assert.equal(
    platformUserDrawerHref("/platform/users", params, "next-user"),
    "/platform/users?q=finance+ops&status=active&page=3&perPage=50&user=next-user",
  );
  assert.equal(
    platformUserDrawerHref("/platform/users", params),
    "/platform/users?q=finance+ops&status=active&page=3&perPage=50",
  );
});

test("opening a platform drawer preserves unrelated repeated filters", () => {
  assert.equal(
    platformDrawerHref(
      "/platform/access",
      { status: ["active", "inactive"], grant: "new" },
      "grant",
    ),
    "/platform/access?status=active&status=inactive",
  );
});
