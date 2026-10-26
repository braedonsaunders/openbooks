import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment, setJsdomInput } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

await bootJsdomEnvironment({ url: "http://localhost:4800/payroll" });
stubModules({
  navigation: {},
  intl: false,
  authz: false,
  features: false,
  extra: { "next/link": "export default function Link(props){return props.children}" },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { RoeSeparationFactsForm } = await import("./roe-separation-facts");
const { OpeningEmployerAuthorityForm } =
  await import("../opening-balances/OpeningEmployerAuthorityForm");

const first = "10000000-0000-4000-8000-000000000001";
const second = "10000000-0000-4000-8000-000000000002";
function employee(name: string) {
  return { employmentId: first, subsidiaryId: second, employerName: name };
}

test("a new ROE event clears issued fields and a changed employee ignores the late prior request", async (t) => {
  const requests: { url: string; resolve: (response: Response) => void }[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = ((url) =>
    String(url).includes("/separations/subsequent-service")
      ? Promise.resolve(Response.json({ record: null, source: null }))
      : new Promise<Response>((resolve) =>
          requests.push({ url: String(url), resolve }),
        )) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
    globalThis.fetch = previous;
  });
  const render = (id: string) =>
    act(() =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <RoeSeparationFactsForm employeePartyId={id} canEdit onSaved={() => {}} />
        </NextIntlClientProvider>,
      ),
    );
  await render(first);
  await act(async () =>
    requests[0]!.resolve(
      Response.json({
        employee: employee("First employer"),
        record: {
          id: first,
          status: "issued",
          firstDayWorked: "2019-01-01",
          interruptionOn: "2026-05-09",
          lastInsurableEarningsOn: "2026-05-08",
          sourceReference: "Original first spell",
          updatedAt: "2026-05-10T00:00:00.000001Z",
        },
      }),
    ),
  );
  assert.match(host.textContent!, /First employer/);
  assert.equal((host.querySelector("#roe-first-worked") as HTMLInputElement).value, "01/01/2019");
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === messages.payroll.filings.separationFacts.newEvent,
  );
  assert.ok(button);
  await act(() => button.click());
  assert.equal(new URL(requests[1]!.url, "http://localhost").searchParams.get("newEvent"), "true");
  assert.equal(
    host.querySelector("#roe-first-worked"),
    null,
    "issued fields are unavailable while the new event loads",
  );
  await render(second);
  await act(async () =>
    requests[1]!.resolve(Response.json({ employee: employee("Stale employer"), record: null })),
  );
  assert.doesNotMatch(host.textContent!, /Stale employer/);
  await act(async () =>
    requests[2]!.resolve(Response.json({ employee: employee("Second employer"), record: null })),
  );
  assert.match(host.textContent!, /Second employer/);
  assert.equal((host.querySelector("#roe-first-worked") as HTMLInputElement).value, "");
  assert.equal((host.querySelector("#roe-source") as HTMLInputElement).value, "");
  assert.equal(new URL(requests[2]!.url, "http://localhost").searchParams.has("newEvent"), false);
});

test("opening source inputs and prior responses cannot cross the selected employee", async (t) => {
  const requests: { resolve: (response: Response) => void }[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => requests.push({ resolve }))) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
    globalThis.fetch = previous;
  });
  const render = (id: string) =>
    act(() =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <OpeningEmployerAuthorityForm
            employeePartyId={id}
            year={2026}
            canManage
            annualDirty={false}
            onSaved={() => {}}
          />
        </NextIntlClientProvider>,
      ),
    );
  const context = (name: string) => ({
    record: {
      id: first,
      openingSha256: "a".repeat(64),
      authorityId: null,
      subsidiaryId: null,
      sourceReference: null,
    },
    employers: [{ id: second, name }],
    source: null,
  });
  await render(first);
  await act(async () => requests[0]!.resolve(Response.json(context("First employer"))));
  const reference = host.querySelector("#opening-source-reference") as HTMLInputElement;
  await act(() => setJsdomInput(reference, "First employee source"));
  await render(second);
  assert.equal(host.querySelector("#opening-source-reference"), null);
  await act(async () => requests[1]!.resolve(Response.json(context("Second employer"))));
  assert.equal((host.querySelector("#opening-source-reference") as HTMLInputElement).value, "");
  assert.match(host.textContent!, /Second employer/);
  assert.doesNotMatch(host.textContent!, /First employer/);
});
