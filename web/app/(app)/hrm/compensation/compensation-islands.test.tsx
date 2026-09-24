import assert from "node:assert/strict";
import test from "node:test";

// F3-33 needs a DOM: the propose form is submitted, not just rendered.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/hrm/compensation/cycles/cycle-1",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: true,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}
globals.IS_REACT_ACT_ENVIRONMENT = true;

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter() { return { push() {}, refresh() {} }; }",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
// The shared @openbooks/ui Select compiles against a global React.
Object.assign(globalThis, { React });
const { renderToString } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
// The shared @openbooks/ui Label resolves its help copy through
// next-intl, so the islands render inside the same provider the app
// always supplies — backed by the real en catalogs, never stubbed.
const messages = (await import("../../../../messages/en")).default;
const { LineDecideButtons, CycleMoveButtons, CompensationSettingsForm, LineProposeForm } = await import("./islands.tsx");
const { CompLineDrawer } = await import("./sections.tsx");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function renderWithIntl(node: React.ReactElement): string {
  return renderToString(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
}

// F3-30/F3-31/F3-32: the compensation islands labelled controls with the
// wrong strings — the decide reason with the Submit copy (wrong for screen
// readers too), the cancel audit reason hard-coded in English, and the
// FTE-rounding select showing raw snake_case codes. Every string now
// arrives as props (loader-resolved from the catalog); the render below
// drives the real components and proves the props reach the controls.
const LABELS = { failed: "The change was refused", submit: "Save", cancel: "Back" };

function labelFor(html: string, id: string): string | null {
  const match = html.match(new RegExp(`<label[^>]*for="${id}"[^>]*>([^<]*)<`));
  return match?.[1] ?? null;
}

test("the decide reason is labelled with its own label, never Submit", () => {
  const html = renderWithIntl(
    <LineDecideButtons
      cycleId="cycle-1"
      lineId="line-1"
      labels={LABELS}
      reasonLabel="Decision reason"
      approveLabel="Approve"
      rejectLabel="Reject"
      reopenLabel="Reopen"
    />,
  );
  assert.equal(labelFor(html, "comp-line-decide-reason"), "Decision reason", "the reason textarea carries its own label");
  const labels = [...html.matchAll(/<label[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.ok(labels.length > 0, "the buttons render their labels");
  assert.ok(!labels.includes("Save"), "no control is labelled with the Submit string");
});

test("cycle cancel asks for a reason instead of posting English audit copy", () => {
  const html = renderWithIntl(
    <CycleMoveButtons
      cycleId="cycle-1"
      labels={LABELS}
      openLabel="Open"
      submitLabel="Submit"
      pushLabel="Push"
      closeLabel="Close"
      cancelLabel="Cancel cycle"
      cancelReasonLabel="Cancellation reason"
      cancelReasonRequired="Cancelling needs a reason"
    />,
  );
  assert.equal(labelFor(html, "comp-cycle-cancel-reason"), "Cancellation reason", "the cancel reason field is labelled");
  assert.match(html, /<textarea[^>]*id="comp-cycle-cancel-reason"/, "the reason is an entered field, not a constant");
  assert.ok(!html.includes("cancelled from the cycle page"), "no hard-coded English audit reason renders");
});

test("the FTE-rounding select shows translated labels, never raw codes", () => {
  const html = renderWithIntl(
    <CompensationSettingsForm
      labels={LABELS}
      initial={{ comparisonAttributeKey: "", gapThresholdPct: "", responseDays: "", fteRounding: "up_to_whole", burdenRate: "" }}
      attributeLabel="Attribute"
      thresholdLabel="Threshold"
      responseDaysLabel="Response days"
      roundingLabel="Rounding"
      roundingOptions={[
        { value: "up_to_whole", label: "Up to a whole number" },
        { value: "nearest_tenth", label: "Nearest tenth" },
        { value: "nearest_hundredth", label: "Nearest hundredth" },
      ]}
      burdenLabel="Burden"
    />,
  );
  for (const label of ["Up to a whole number", "Nearest tenth", "Nearest hundredth"]) {
    assert.ok(html.includes(`>${label}</option>`), `the select offers "${label}"`);
  }
  assert.ok(!html.includes(">up_to_whole<"), "no raw snake_case code renders as an option");
  assert.ok(!html.includes(">nearest_tenth<"), "no raw snake_case code renders as an option");
  assert.ok(!html.includes(">nearest_hundredth<"), "no raw snake_case code renders as an option");
});

// F3-33: Number('abc') is NaN, which JSON serializes as null — the old
// submit posted an empty proposal the server could only refuse blindly.
// The form now parses through the exact decimal grammar, refuses
// garbage and negatives by name without posting, and sends the
// canonical decimal string.
const PROPOSE_LABELS = {
  ...LABELS,
  pctInvalid: "The raise must be a plain non-negative number",
};
const posted: { url: string; body: string }[] = [];

function stubFetch(): void {
  posted.length = 0;
  (globalThis as Record<string, unknown>).fetch = (async (input: unknown, init?: { body?: unknown }) => {
    posted.push({ url: String(input), body: String(init?.body ?? "") });
    return Response.json({ id: "line-1" });
  }) as typeof fetch;
}

async function submitPct(pctValue: string): Promise<{ postedCount: number; body: string; text: string }> {
  stubFetch();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LineProposeForm
          cycleId="cycle-1"
          lineId="line-1"
          labels={LABELS}
          pctLabel="Raise %"
          rateLabel="New rate"
          reasonLabel="Reason"
          pctInvalidLabel={PROPOSE_LABELS.pctInvalid}
          closeHref="/hrm/compensation/cycles/cycle-1"
        />
      </NextIntlClientProvider>,
    );
  });
  const input = host.querySelector("#comp-line-pct") as HTMLInputElement;
  assert.ok(input, "the pct field renders");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter, "the DOM value setter exists");
  await act(async () => {
    setter!.call(input, pctValue);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const form = host.querySelector("form");
  assert.ok(form, "the propose form renders");
  await act(async () => {
    form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    await tick();
  });
  const result = { postedCount: posted.length, body: posted[0]?.body ?? "", text: host.textContent ?? "" };
  await act(async () => {
    root.unmount();
  });
  host.remove();
  return result;
}

test("an unparseable percent is refused by name and never posted", async () => {
  const refused = await submitPct("abc");
  assert.equal(refused.postedCount, 0, "garbage never reaches the route as a null proposal");
  assert.ok(refused.text.includes(PROPOSE_LABELS.pctInvalid), "the named refusal renders beside the form");
});

test("a negative percent is refused by name and never posted", async () => {
  const refused = await submitPct("-2");
  assert.equal(refused.postedCount, 0, "a negative raise never reaches the route");
  assert.ok(refused.text.includes(PROPOSE_LABELS.pctInvalid), "the named refusal renders beside the form");
});

test("a valid percent posts the canonical decimal string", async () => {
  const sent = await submitPct("3.50");
  assert.equal(sent.postedCount, 1, "one proposal posts");
  const body = JSON.parse(sent.body) as { proposedPct: unknown };
  assert.equal(body.proposedPct, "3.5", "the wire carries the canonical decimal string, never a float");
  assert.ok(!sent.text.includes(PROPOSE_LABELS.pctInvalid), "no refusal renders for valid input");
});

// F3-38: the drawer arms only the actions the transition table allows —
// a pushed line offers neither form even to a decider.
function drawerWith(actions: { canPropose: boolean; canDecideLine: boolean }) {
  return {
    open: true,
    closeHref: "/hrm/compensation/cycles/cycle-1",
    title: "Line",
    line: { id: "line-1", employeeName: "Ava", status: "pushed" } as never,
    history: [],
    labels: {
      failed: "The change was refused",
      submit: "Save",
      cancel: "Back",
      proposeTitle: "Propose",
      decideTitle: "Decide",
      historyTitle: "History",
      pctLabel: "Raise %",
      rateLabel: "New rate",
      reasonLabel: "Reason",
      pctInvalid: PROPOSE_LABELS.pctInvalid,
      decideReasonLabel: "Decision reason",
      approve: "Approve",
      reject: "Reject",
      reopen: "Reopen",
    },
    cycleId: "cycle-1",
    canDecide: true,
    ...actions,
    historyColumns: { event: "Event", reason: "Reason", at: "At" },
    emptyHistory: "No events yet.",
  };
}

async function drawerText(drawer: ReturnType<typeof drawerWith>): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CompLineDrawer drawer={drawer as never} />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  // The drawer portals into document.body, so read the whole document;
  // each drawer mounts alone and unmounts before the next.
  const body = document.body.innerHTML;
  const text = document.body.textContent ?? "";
  await act(async () => {
    root.unmount();
  });
  host.remove();
  return `${text} ${body.includes('id="comp-line-pct"') ? "HAS-PCT-FORM" : "NO-PCT-FORM"}`;
}

test("a pushed line offers neither form", async () => {
  const text = await drawerText(drawerWith({ canPropose: false, canDecideLine: false }));
  assert.ok(text.includes("NO-PCT-FORM"), "the propose form is hidden past push");
  assert.ok(!text.includes("Approve"), "the decide buttons are hidden past push");
});

test("a proposed line on a live round offers both forms", async () => {
  const text = await drawerText(drawerWith({ canPropose: true, canDecideLine: true }));
  assert.ok(text.includes("HAS-PCT-FORM"), "the propose form renders while the round is live");
  assert.ok(text.includes("Approve"), "the decide buttons render for a proposed line");
});
