import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

const id = "00000000-0000-4000-8000-000000000042";
const state = {
  query: `view=programs&program=${id}`,
  reads: 0,
  load: async (): Promise<unknown> => ({}),
};
await bootJsdomEnvironment({
  url: `http://localhost:4800/hrm/benefits?${state.query}`,
  matchMediaMatches: false,
});
(globalThis as Record<string, unknown>).__programDrawerHost = state;
stubModules({
  navigation: `
  export function usePathname() { return '/hrm/benefits' }
  export function useSearchParams() { return new URLSearchParams(globalThis.__programDrawerHost.query) }
  export function useRouter() { return {push() {throw new Error('Drawer-only navigation must not reload the page')}} }
`,
  extra: {
    "./program-drawer-action": `export async function loadBenefitProgramDrawer() { const state=globalThis.__programDrawerHost; state.reads++; return state.load() }`,
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { UrlDrawer } = await import("@openbooks/ui");
const { ProgramDrawerHost } = await import("./ProgramDrawerHost");
const messages = {
  common: (await import("../../../../messages/en/common.json", { with: { type: "json" } })).default,
  ui: (await import("../../../../messages/en/ui.json", { with: { type: "json" } })).default,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
function Record() {
  return (
    <UrlDrawer open title="Native program" closeHref="/hrm/benefits">
      <input aria-label="Program draft" defaultValue="Saved value" />
    </UrlDrawer>
  );
}

test("background server refresh reauthorizes without remounting a native draft; reopening reads fresh data", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  state.load = async () => ({ content: <Record /> });
  async function render(refreshKey: string) {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <ProgramDrawerHost refreshKey={refreshKey} />
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await act(async () => {
      await tick();
    });
  }
  await render("initial-page");
  const shell = document.querySelector('[role="dialog"]');
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Program draft"]');
  assert.ok(shell);
  assert.ok(field);
  field.value = "Unsaved operator draft";
  const reads = state.reads;
  await render("refreshed-page");
  assert.ok(state.reads > reads, "a server refresh reauthorizes the program");
  assert.ok(document.querySelector('[role="dialog"]') === shell);
  assert.ok(
    document.querySelector('input[aria-label="Program draft"]') === field,
    "background refresh must retain the native form instance",
  );
  assert.equal(field.value, "Unsaved operator draft");
  state.query = "view=programs";
  await render("refreshed-page");
  const beforeReopen = state.reads;
  state.query = `view=programs&program=${id}`;
  await render("refreshed-page");
  assert.ok(state.reads > beforeReopen, "reopening performs a fresh authorized read");
  assert.equal(
    document.querySelector<HTMLInputElement>('input[aria-label="Program draft"]')?.value,
    "Saved value",
  );
});
