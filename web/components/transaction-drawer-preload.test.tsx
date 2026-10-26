import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

await bootJsdomEnvironment({
  url: "http://localhost/hrm/benefits?program=11111111-1111-4111-8111-111111111111",
  matchMediaMatches: false,
});
stubModules({
  navigation: {
    source:
      "export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return {push(){},replace(){},refresh(){},prefetch(){},back(){}}}",
  },
  intl: false,
  authz: false,
  features: false,
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { TransactionDrawer } = await import("./transaction-drawer");
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(t: test.TestContext, options: { preload?: boolean; evidence?: boolean } = {}) {
  const requests: URLSearchParams[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    assert.ok(href.startsWith("/api/audit/record?"), `unexpected request: ${href}`);
    requests.push(new URL(href, "http://localhost").searchParams);
    return Response.json({
      rows: [],
      total: 0,
      page: 1,
      perPage: 15,
      actions: [],
      recordType: "hrm_benefit_program",
    });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
  });
  async function render(tab: string, recordId = firstId, refreshKey = 0) {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <TransactionDrawer
            closeHref="/hrm/benefits"
            title="Program"
            recordId={recordId}
            targetTable="hrm_benefit_programs"
            showAttachments={false}
            showEvidenceTabs={options.evidence ?? true}
            mountAllRecordTabs={options.preload ?? true}
            auditRefreshKey={refreshKey}
            activeTab={tab}
            detailTabs={[
              {
                key: "participants",
                label: "Participants",
                content: <input aria-label="Participant search" />,
              },
            ]}
          >
            <p>Program rules</p>
          </TransactionDrawer>
        </NextIntlClientProvider>,
      );
    });
    await act(async () => {
      await tick();
      await tick();
    });
  }
  await render("details");
  return { requests, render };
}

test("preloaded audit is fetched at open and retained across tab changes", async (t) => {
  const { requests, render } = await mount(t);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.get("id"), firstId);
  const auditSearch = document.querySelector<HTMLInputElement>(
    `input[placeholder="${messages.common.auditTrail.searchPlaceholder}"]`,
  );
  assert.ok(auditSearch);
  assert.ok(auditSearch.closest("[hidden]"), "inactive audit controls are hidden");
  await render("audit");
  assert.equal(auditSearch.closest("[hidden]"), null);
  await render("participants");
  await render("audit");
  assert.equal(requests.length, 1, "returning to audit reuses its data");
  assert.equal(
    document.querySelector(`input[placeholder="${messages.common.auditTrail.searchPlaceholder}"]`),
    auditSearch,
    "audit retains the same controls",
  );
  await render("details", firstId, 1);
  assert.equal(requests.length, 2, "a saved change reloads the same record history");
  assert.equal(requests[1]!.get("id"), firstId);
  assert.equal(
    document.querySelector(`input[placeholder="${messages.common.auditTrail.searchPlaceholder}"]`),
    auditSearch,
    "a save preserves audit controls",
  );
  await render("details", secondId, 1);
  assert.equal(requests.length, 3, "a different record loads its own history");
  assert.equal(requests[2]!.get("id"), secondId);
  assert.notEqual(
    document.querySelector(`input[placeholder="${messages.common.auditTrail.searchPlaceholder}"]`),
    auditSearch,
    "record-local audit state is reset",
  );
});

test("preloading does not request evidence when evidence tabs are disabled", async (t) => {
  const { requests, render } = await mount(t, { evidence: false });
  await render("audit");
  assert.equal(requests.length, 0);
  assert.ok(document.body.textContent?.includes("Program rules"));
});

test("drawers without preloading keep audit requests deferred until selection", async (t) => {
  const { requests, render } = await mount(t, { preload: false });
  assert.equal(requests.length, 0);
  await render("audit");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.get("id"), firstId);
});
