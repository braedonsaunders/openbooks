import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

// The header's Tolerances action requests the drawer through the address.
await bootJsdomEnvironment({
  url: "http://localhost:4800/payroll/parallel-run?tolerances=1",
  matchMediaMatches: false,
});

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){}}}" +
      "export function useSearchParams(){return new URLSearchParams(window.location.search)}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return React.createElement('a',p,p.children)}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { ParallelRunView } = await import("./ParallelRunView");

test("the tolerance drawer opens from its header request and names its remove control", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ParallelRunView
            registers={[]}
            runs={[]}
            comparisons={[]}
            tolerances={[
              { kind: "earning", slot: "base", tolerance: "1.00", reason: "rounding", id: "tol-1" },
            ]}
            slots={[]}
            canManage
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
  });
  assert.ok(
    document.querySelector('[role="dialog"]'),
    "the header request opens the tolerance drawer",
  );
  assert.ok(
    document.querySelector('button[aria-label="Delete"]'),
    "remove tolerance control has a translated name",
  );
});
