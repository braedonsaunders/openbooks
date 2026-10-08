import assert from "node:assert/strict";
import test from "node:test";

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function redirect(url){throw{digest:'NEXT_REDIRECT',url}};export function notFound(){throw{digest:'NEXT_NOT_FOUND'}}",
      };
    }
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return(key)=>key};export async function getLocale(){return'en'}",
      };
    }
    if (specifier === "@openbooks/engine/portal") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function resolvePortalSession(){return globalThis.__portalCase.session};export async function consumePortalLink(){return globalThis.__portalCase.consume()};export async function portalHome(){throw new Error('unreached')};export async function portalBillingReviews(){throw new Error('unreached')}",
      };
    }
    if (specifier === "@openbooks/engine/platform/database") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const db={};export async function withOrgContext(org,fn){return fn()}",
      };
    }
    return next(specifier, context);
  },
});

type PortalCase = {
  session: null;
  consume: () => Promise<{ sessionToken: string }>;
};

function portalCase(consume: PortalCase["consume"]) {
  (globalThis as Record<string, unknown>).__portalCase = { session: null, consume };
}

const { default: PortalTokenPage } = (await import("./page")) as {
  default: (args: {
    params: Promise<{ token: string }>;
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<unknown>;
};

/**
 * A consumed portal link must redirect to its session: Next's redirect
 * throws to abort rendering, so catching it into a 404 would swallow a
 * successful consume and strand the customer on a dead page.
 */
test("a consumed portal link redirects instead of refusing", async () => {
  portalCase(async () => ({ sessionToken: "session-2" }));
  await assert.rejects(
    PortalTokenPage({ params: Promise.resolve({ token: "link-1" }) }),
    (error: unknown) =>
      (error as { digest?: string }).digest === "NEXT_REDIRECT" &&
      (error as { url?: string }).url === "/portal/session-2",
  );
});

/**
 * An unconsumable link still refuses: only the redirect escapes the
 * consume attempt, never a failed consume.
 */
test("an unconsumable portal link refuses", async () => {
  portalCase(async () => {
    throw new Error("link unknown");
  });
  await assert.rejects(
    PortalTokenPage({ params: Promise.resolve({ token: "link-bad" }) }),
    (error: unknown) => (error as { digest?: string }).digest === "NEXT_NOT_FOUND",
  );
});

/**
 * A review invitation lands on the package it names, and only a well-formed
 * record id is carried through the redirect.
 */
test("a review invitation redirects to the named billing review", async () => {
  portalCase(async () => ({ sessionToken: "session-3" }));
  const reviewId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  await assert.rejects(
    PortalTokenPage({ params: Promise.resolve({ token: "link-2" }), searchParams: Promise.resolve({ review: reviewId }) }),
    (error: unknown) => (error as { url?: string }).url === `/portal/session-3/reviews/${reviewId}`,
  );
  await assert.rejects(
    PortalTokenPage({ params: Promise.resolve({ token: "link-3" }), searchParams: Promise.resolve({ review: "../admin" }) }),
    (error: unknown) => (error as { url?: string }).url === "/portal/session-3",
  );
});
