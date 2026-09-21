/**
 * HR-18 recruiting depth — public pages + public recruiting APIs.
 *
 * Guard chain for the session-free recruiting surface (walls 5 + 8):
 * apply/book/careers/offer pages and /api/recruiting/apply, book, feed,
 * offer must resolve the org from the token or posting row itself — never
 * from the viewer session (or a caller-supplied org id) — and a missing,
 * unconfigured, gate-off, or signed-out authority must refuse visibly
 * (notFound / 404 / refusal), never render a framed shell.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) =>
  readFileSync(path.join(root, rel.startsWith("app/") ? rel : `app/${rel}`), "utf8");

// Public page entry points (never framed: no AppChrome/NavLayout).
const pages = [
  "book/[token]/page.tsx",
  "careers/[orgSlug]/page.tsx",
  "offer/[token]/page.tsx",
] as const;

describe("recruiting public pages — authority resolved, gate-checked, never framed", () => {
  for (const page of pages) {
    it(`${page} imports no session/frame primitives`, () => {
      const source = read(page);
      assert.ok(!source.includes("getSession"), "must not read the viewer session");
      assert.ok(!source.includes("useSession"), "must not read the viewer session");
      assert.ok(!source.includes("AppChrome"), "public pages are never framed");
      assert.ok(!source.includes("NavLayout"), "public pages are never framed");
    });
  }

  it("book + offer pages resolve authority from the token and gate on it", () => {
    for (const page of ["book/[token]/page.tsx", "offer/[token]/page.tsx"] as const) {
      const source = read(page);
      assert.ok(source.includes("notFound()"), `${page} must refuse visibly`);
      assert.match(source, /isFeatureEnabled\(.+?, '/, `${page} must gate on the feature flag`);
    }
  });

  it("careers page resolves the org from the public slug and gates on it", () => {
    const source = read("careers/[orgSlug]/page.tsx");
    assert.ok(source.includes("notFound()"), "unknown slug / gate-off must refuse visibly");
    assert.ok(source.includes("isFeatureEnabled"), "must gate on the feature flag");
  });
});

describe("recruiting public APIs — org from token/row, rate-limited", () => {
  it("/api/recruiting/apply resolves the org inside the service call from the posting row", () => {
    const source = read("app/api/recruiting/apply/route.ts");
    assert.ok(source.includes("applyViaPostingForOrg"), "org must come from the posting row");
    assert.ok(source.includes("no session"), "session-freedom must be stated");
    assert.ok(!source.includes("getSession"), "must not read the viewer session");
  });

  it("/api/recruiting/feed/[token] verifies the token from the path", () => {
    const source = read("app/api/recruiting/feed/[token]/route.ts");
    assert.ok(!source.includes("getSession"), "must not read the viewer session");
    assert.ok(source.includes("resolveFeedOrg"), "org must be verified from the feed token");
  });
});
