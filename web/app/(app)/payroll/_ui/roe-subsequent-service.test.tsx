import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";
import type { RoeSeparationFacts } from "@openbooks/engine/payroll/roe-separation-facts";
await bootJsdomEnvironment({ url: "https://openbooks.test/payroll/separations" });
stubModules({ navigation: true, intl: false, authz: false, features: false });
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { RoeSubsequentServiceForm } = await import("./roe-subsequent-service");
const event: RoeSeparationFacts = {
  id: "019f0000-0000-4000-8000-000000000001",
  employeePartyId: "019f0000-0000-4000-8000-000000000002",
  employmentId: "019f0000-0000-4000-8000-000000000003",
  subsidiaryId: "019f0000-0000-4000-8000-000000000004",
  firstDayWorked: "2026-01-01",
  interruptionOn: "2026-08-10",
  lastInsurableEarningsOn: "2026-08-01",
  salaryContinuanceEndOn: null,
  status: "confirmed",
  changeReason: "Original interruption",
  updatedAt: "2026-08-11T00:00:00Z",
  sourceReference: "Original interruption declaration",
};
const record = {
  id: "019f0000-0000-4000-8000-000000000005",
  precedingEventId: event.id,
  firstDayWorked: "2026-08-11",
  sourceFileId: "019f0000-0000-4000-8000-000000000006",
  sourceVersionId: "019f0000-0000-4000-8000-000000000007",
  sourceSha256: "a".repeat(64),
  sourceReference: "Signed return declaration",
  reason: "Retain later service",
  updatedAt: "2026-08-12T00:00:00Z",
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
async function mount(selected: RoeSeparationFacts) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <RoeSubsequentServiceForm
          employeePartyId={selected.employeePartyId}
          event={selected}
          canEdit
          onSaved={() => {}}
        />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  return { host, root };
}
test("issued event shows its exact retained return source without authoring controls", async (t) => {
  const previous = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    return Response.json({ record, source: null });
  }) as typeof fetch;
  const { host, root } = await mount({ ...event, status: "issued" });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = previous;
  });
  await act(tick);
  assert.match(host.textContent ?? "", /Signed return declaration/);
  assert.equal(
    (host.querySelector("#roe-return-first-worked") as HTMLInputElement).value,
    "08/11/2026",
  );
  assert.equal((host.querySelector("#roe-return-first-worked") as HTMLInputElement).disabled, true);
  assert.equal(host.querySelector("#roe-return-file"), null);
  assert.ok(
    ![...host.querySelectorAll("button")].some(
      (b) => b.textContent === "Save return-to-work evidence",
    ),
  );
  const query = new URL(requests[0]!, window.location.origin).searchParams;
  assert.equal(query.get("precedingEventId"), event.id);
  assert.equal(query.get("employmentId"), event.employmentId);
  assert.equal(query.get("subsidiaryId"), event.subsidiaryId);
});
test("read refusal stays in the same form and retry reads the selected event without losing scope", async (t) => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () =>
    ++calls === 1
      ? Response.json({ error: "Original employer is outside your payroll scope" }, { status: 422 })
      : Response.json({ record, source: null })) as typeof fetch;
  const { host, root } = await mount(event);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = previous;
  });
  await act(tick);
  assert.match(host.textContent ?? "", /outside your payroll scope/);
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  assert.ok(retry);
  await act(async () => {
    retry.click();
    await tick();
    await tick();
  });
  assert.match(host.textContent ?? "", /Signed return declaration/);
  assert.equal(calls, 2);
  assert.equal(
    (host.querySelector("#roe-return-first-worked") as HTMLInputElement).disabled,
    false,
  );
  const save = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Save return-to-work evidence",
  );
  assert.ok(save);
  assert.equal(
    save.disabled,
    true,
    "a retained record does not silently supply an editable source version",
  );
});
test("an old event response cannot populate a newly selected employment event", async (t) => {
  const previous = globalThis.fetch;
  let release: (value: Response) => void = () => {};
  const older = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  globalThis.fetch = (async () =>
    ++calls === 1
      ? older
      : Response.json({
          record: {
            ...record,
            precedingEventId: "019f0000-0000-4000-8000-000000000009",
            firstDayWorked: "2026-09-11",
            sourceReference: "Later original event",
          },
          source: null,
        })) as typeof fetch;
  const { host, root } = await mount(event);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = previous;
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <RoeSubsequentServiceForm
          employeePartyId={event.employeePartyId}
          event={{ ...event, id: "019f0000-0000-4000-8000-000000000009" }}
          canEdit
          onSaved={() => {}}
        />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  await act(async () => {
    release(Response.json({ record, source: null }));
    await tick();
  });
  assert.match(host.textContent ?? "", /Later original event/);
  assert.doesNotMatch(host.textContent ?? "", /Signed return declaration/);
  assert.equal(
    (host.querySelector("#roe-return-first-worked") as HTMLInputElement).value,
    "09/11/2026",
  );
});
