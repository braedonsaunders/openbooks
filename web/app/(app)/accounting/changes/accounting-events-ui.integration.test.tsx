import assert from "node:assert/strict";
import test from "node:test";
import { resolveEngineSpecifier } from "../../../../testing/engine-resolve-hooks.ts";

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation: "export function useRouter(){return {push(){},refresh(){},replace(){}}}",
  intl: true,
});
registerHooks({
  resolve(specifier, context, next) {
    // Engine contracts resolve to this checkout, not a symlinked install.
    const engineUrl = resolveEngineSpecifier(specifier);
    if (engineUrl) return next(engineUrl, context);

    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement('a',rest,children)}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const { ChangeActions } = await import("./ChangeActions");
const { groupTabs } = await import("../../../../components/module-home/group-tabs.ts");
const { NAV_MODULES } = await import("@openbooks/engine/navigation");

test("pending accounting events direct their decision to the Inbox", () => {
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{
        accounting: { lifecycle: { reviewInbox: "Review in Inbox" } },
      }}
      timeZone="UTC"
    >
      <ChangeActions id="change-1" status="pending" canSubmit canApply />
    </NextIntlClientProvider>,
  );

  assert.match(markup, /<a[^>]*href="\/inbox"[^>]*>Review in Inbox<\/a>/);
  assert.doesNotMatch(markup, /Submit for approval|Apply approved event/);
});

test("accounting event history is not offered as a daily group tab", async () => {
  // The accounting group strip is retired: the cockpit and the main menu own
  // cross-module discovery. The register is listed beside Period Close in the
  // accounting menu, so Period Close is where it is opened from.
  const tabs = await groupTabs("accounting", "/accounting/changes", {
    orgId: "00000000-0000-4000-8000-000000000000",
  });
  assert.deepEqual(tabs, [], "accounting has no daily group strip");

  const register = NAV_MODULES.find((module) => module.key === "accounting-changes");
  const close = NAV_MODULES.find((module) => module.key === "close");
  assert.equal(register?.group, "accounting");
  assert.ok(close, "period close is a registered accounting destination");
  assert.equal(
    register?.subgroup,
    close.subgroup,
    "accounting events sit with Period Close in the menu",
  );
});
