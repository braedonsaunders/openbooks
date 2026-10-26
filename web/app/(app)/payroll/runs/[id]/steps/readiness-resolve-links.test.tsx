import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../../../testing/jsdom-env";
import { stubModules } from "../../../../../../testing/stub-modules";

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){},back(){}}};" +
      'export function usePathname(){return "/payroll/runs/run-1"};' +
      "export function useSearchParams(){return new URLSearchParams()};" +
      "export function useParams(){return {}}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link":
      'export default function Link(p){return globalThis.React.createElement("a",{href:p.href},p.children)}',
    sonner: "export const toast={success(){},error(){},warning(){}}",
  },
});

// The readiness "no payroll link" blocker carries a one-click Resolve action:
// the button posts the blocker's employees to the run's
// resolve-employment-links action and reports who was linked and who still
// needs a manual link, instead of sending the operator to fix every row by
// hand. Mounts the real step under jsdom and asserts the request the click
// sends and the result it renders.
await bootJsdomEnvironment({
  url: "http://localhost:4800/payroll/runs/doc-1",
  matchMediaMatches: false,
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../../messages/en")).default;
const { ReadinessStep } = await import("./ReadinessStep");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

type StepProps = Parameters<typeof ReadinessStep>[0];

const blocker = {
  severity: "blocker",
  code: "employee.noEmployment",
  employees: [
    { partyId: "11111111-1111-4111-8111-111111111111", name: "Ada" },
    { partyId: "22222222-2222-4222-8222-222222222222", name: "Bo" },
  ],
  href: "/entities/employees",
  action: "payroll.resolve-employment-links",
} as unknown as StepProps["readiness"]["items"][number];

const props = {
  runId: "doc-1",
  roster: [],
  readiness: { items: [blocker], blockers: 1, warnings: 0, included: 2 },
  canCalculate: false,
  calculated: false,
  busy: false,
  dry: null,
  onDryRun: () => {},
  onCalculate: () => {},
  onAnswered: () => {},
  fmt: (v: unknown) => String(v ?? ""),
} as unknown as StepProps;

async function mount(t: TestContext) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootHandle = createRoot(host);
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount();
    });
    host.remove();
    for (const child of [...document.body.children]) child.remove();
  });
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ReadinessStep {...props} />
      </NextIntlClientProvider>,
    );
  });
  await tick();
  return host;
}

function clickByText(host: Element, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    HTMLButtonElement | undefined;
  assert.ok(button, `expected a button reading "${text}"`);
  return button;
}

test("the employment-link blocker offers a one-click resolve that posts the listed employees", async (t) => {
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(
      JSON.stringify({
        ok: true,
        linked: [
          {
            employeePartyId: "11111111-1111-4111-8111-111111111111",
            employeeName: "Ada",
            employmentId: "e-1",
            linked: true,
            reason: null,
          },
        ],
        unresolved: [
          {
            employeePartyId: "22222222-2222-4222-8222-222222222222",
            employeeName: "Bo",
            employmentId: null,
            linked: false,
            reason: "no employment on file — complete the hire first",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const host = await mount(t);
  await act(async () => {
    clickByText(host, "Link employments").click();
    await tick();
    await tick();
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/payroll/runs/doc-1");
  assert.deepEqual(calls[0]!.body, {
    action: "resolve-employment-links",
    employeePartyIds: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
  });
  const text = host.textContent ?? "";
  assert.match(text, /1 employment linked/);
  assert.match(text, /1 employee still needs a manual link/);
  assert.match(text, /Bo/);
  assert.match(text, /no employment on file/);
});

test("a failed resolve leaves the blocker in place and reports the refusal", async (t) => {
  const complaints: string[] = [];
  const realFetch = globalThis.fetch;
  const sonner = await import("sonner");
  const realError = sonner.toast.error;
  sonner.toast.error = ((message: string) => {
    complaints.push(message);
  }) as typeof sonner.toast.error;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: "Payroll manage permission is required to link employments" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    sonner.toast.error = realError;
  });
  const host = await mount(t);
  await act(async () => {
    clickByText(host, "Link employments").click();
    await tick();
    await tick();
  });
  assert.equal(complaints.length, 1);
  assert.match(complaints[0]!, /Payroll manage permission/);
  assert.match(host.textContent ?? "", /no payroll link/);
});
