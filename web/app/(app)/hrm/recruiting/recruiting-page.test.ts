import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the recruiting depth tabs (HR-18): Interviews,
// Offers, Postings, and Pools ride /hrm/recruiting as ?tab= sub-tabs.
// Unknown or switched-off tabs fall back to Openings (absent, never an
// error) and selection hrefs are stable. The Hiring strip is the view-tab
// registry's and is covered with it. The only seam is the feature switch;
// the tab services behind each surface stay covered by the engine
// recruiting tests, not doubled here.
registerHooks({
  resolve(specifier, context, nextResolve) {

    if (specifier === "../../../../lib/features") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function isFeatureEnabled(orgId, key) {
              const flags = globalThis.__depthFeatures;
              if (flags && key in flags) return flags[key];
              return true;
            }
            export async function requireFeatureEnabled() {}`,
          ),
      };
    }
    return nextResolve(specifier, context);
  },
});

const { hrefForDepth, resolveDepthTab } = await import("./depth-view.ts");

const gap = globalThis as Record<string, unknown>;

function authz() {
  return { user: { orgId: "org-recruiting", id: "actor-recruiting" } } as never;
}

function flags(set: Record<string, boolean>) {
  gap.__depthFeatures = set;
}

test("an unknown or switched-off tab falls back to Openings", async () => {
  flags({});
  assert.equal(await resolveDepthTab(authz(), "bogus"), "openings", "unknown tabs fall back");
  assert.equal(await resolveDepthTab(authz(), undefined), "openings", "an absent tab is Openings");
  assert.equal(await resolveDepthTab(authz(), 123), "openings", "a non-string tab is Openings");
  assert.equal(await resolveDepthTab(authz(), "openings"), "openings", "Openings needs no switch");

  flags({ hrmStructuredInterviews: false });
  assert.equal(await resolveDepthTab(authz(), "interviews"), "openings", "a switched-off tab is absent, not an error");

  flags({ hrmStructuredInterviews: true });
  assert.equal(await resolveDepthTab(authz(), "interviews"), "interviews", "a switched-on tab resolves");
});

test("selection hrefs keep the tab and the selection", () => {
  assert.equal(hrefForDepth("openings", null), "/hrm/recruiting?tab=openings");
  assert.equal(hrefForDepth("interviews", { interview: "i-1" }), "/hrm/recruiting?tab=interviews&interview=i-1");
  assert.equal(hrefForDepth("offers", { offer: "o-9" }), "/hrm/recruiting?tab=offers&offer=o-9");
});
