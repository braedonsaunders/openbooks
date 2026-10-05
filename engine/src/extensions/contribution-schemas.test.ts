import { test } from "node:test";
import assert from "node:assert/strict";
import { navContributionSchema } from "./contribution-schemas.ts";

const nav = (href: string) => navContributionSchema.safeParse({ kind: "nav", label: "Rebates", href, group: "customers" });

test("module nav links resolve only to in-app paths", () => {
  for (const href of ["/x/rebates", "/x/rebates/", "/x/rebates/[id]", "/x/a-b_c/(tab).v2"]) {
    assert.equal(nav(href).success, true, href);
  }
  for (const href of ["//evil.example/login", "///evil.example", "/x//evil.example", "https://evil.example", "x/rebates", "/x/\\evil", ""]) {
    const parsed = nav(href);
    assert.equal(parsed.success, false, href);
    assert.match(parsed.error!.issues[0]!.message, /in-app absolute path/, href);
  }
});
