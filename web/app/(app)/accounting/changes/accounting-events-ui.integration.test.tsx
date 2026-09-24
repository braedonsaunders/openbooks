import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import test from "node:test";

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return key=>key}",
      };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){}}}",
      };
    }
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

test("pending accounting events direct their decision to the Inbox", () => {
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{
        accounting: { lifecycle: { reviewInbox: "Review in Inbox" } },
      }}
      timeZone="UTC"
    >
      <ChangeActions
        id="change-1"
        status="pending"
        canSubmit
        canApply
      />
    </NextIntlClientProvider>,
  );

  assert.match(markup, /<a[^>]*href="\/inbox"[^>]*>Review in Inbox<\/a>/);
  assert.doesNotMatch(markup, /Submit for approval|Apply approved event/);
});

test("accounting event history is not offered as a daily group tab", async (t) => {
  const org = await withBypassContext(() => createScratchOrg());
  t.after(() => dropScratchOrg(org.orgId));
  await withBypassContext(() =>
    db.execute(sql`update orgs
      set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,continuousClose}', 'true'::jsonb, true)
      where id = ${org.orgId}`),
  );

  const tabs = await withOrgContext(org.orgId, () =>
    groupTabs("accounting", "/accounting/changes", { orgId: org.orgId }),
  );

  assert.ok(tabs.some((tab) => tab.href === "/close"), "period close remains on the daily accounting strip");
  assert.ok(!tabs.some((tab) => tab.href === "/accounting/changes"), "accounting event history is opened from Period Close");
});
