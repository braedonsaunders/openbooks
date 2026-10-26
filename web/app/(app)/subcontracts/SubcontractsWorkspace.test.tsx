import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/subcontracts", matchMediaMatches: false });

const script = { requests: [] as string[] };
Object.assign(globalThis, {
  __subcontractsTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
  __subcontractsSearchParams: "",
});
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    'export function useRouter(){return globalThis.__subcontractsTestRouter}export function usePathname(){return "/subcontracts"}export function useSearchParams(){return new URLSearchParams(globalThis.__subcontractsSearchParams ?? "")}',
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner: "export const toast={success(){},error(){}};export function Toaster(){return null}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { SubcontractsWorkspace } = await import("./SubcontractsWorkspace");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(t: TestContext, searchParams: string): Promise<void> {
  script.requests = [];
  (globalThis as Record<string, unknown>).__subcontractsSearchParams = searchParams;
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    script.requests.push(String(input));
    return new Response("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootHandle = createRoot(host);
  t.after(async () => {
    await act(async () => rootHandle.unmount());
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-01">
            <SubcontractsWorkspace
              projects={[]}
              vendors={[]}
              expenseAccounts={[]}
              parties={[]}
              permissions={{ create: true, approve: false, post: false, pay: false }}
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    for (let i = 0; i < 6; i++) await tick();
  });
}

test("the workspace does not fetch the server-loaded register in the browser", async (t) => {
  await mount(t, "");
  assert.deepEqual(script.requests, []);
});

test("a URL-addressed detail drawer shows inline load errors and retries the requested record", async (t) => {
  const id = "6f7de97f-0807-4f47-b6a2-e0e3c6ae8c2d";
  await mount(t, `subcontract=${id}&tab=changes`);

  assert.deepEqual(script.requests, [`/api/subcontracts?id=${id}`]);
  assert.ok(document.body.textContent?.includes("Could not load subcontract (status 502)"));
  const retry = [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Retry"),
  );
  assert.ok(retry, "the failed drawer request exposes a retry action");

  await act(async () => {
    retry?.click();
    for (let i = 0; i < 6; i++) await tick();
  });
  assert.deepEqual(script.requests, [`/api/subcontracts?id=${id}`, `/api/subcontracts?id=${id}`]);
});
