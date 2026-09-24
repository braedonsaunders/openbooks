import assert from "node:assert/strict";
import test from "node:test";

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function redirect(url){throw new Error('REDIRECT:'+url)}",
      };
    }
    if (specifier === "next-intl/server") {
      return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key}" };
    }
    if (
      specifier === "./view" &&
      context.parentURL?.endsWith("/web/app/(app)/continuous-close/page.tsx")
    ) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function loadContinuousClose(){return {}};export function continuousCloseSpec(){return {}}",
      };
    }
    if (specifier.endsWith("/components/viewspec/module-view")) {
      return { shortCircuit: true, url: "data:text/javascript,export function ModuleView(){return null}" };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { default: continuousClosePage } = await import("../continuous-close/page");

async function expectRedirect(searchParams: Record<string, string | string[] | undefined>, href: string) {
  await assert.rejects(
    () => continuousClosePage({ searchParams: Promise.resolve(searchParams) }),
    (error: unknown) => error instanceof Error && error.message === `REDIRECT:${href}`,
  );
}

test("retired workbench URL redirects with landing context", async () => {
  await expectRedirect({}, "/agents?from=continuous-close");
});

test("retired workbench URL preserves the first item deep link", async () => {
  await expectRedirect(
    { item: ["8c3a8df0-e32d-4f60-a3b9-5fb1cda1b85c", "ignored"], q: "discarded" },
    "/agents?from=continuous-close&item=8c3a8df0-e32d-4f60-a3b9-5fb1cda1b85c",
  );
});

test("reports remains on the legacy route", async () => {
  const result = await continuousClosePage({ searchParams: Promise.resolve({ tab: "reports" }) });
  assert.ok(result, "reports renders the retained legacy page instead of redirecting");
});
