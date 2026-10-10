// Project geofences list under the drawer sublist archetype: Add geofence top
// right opens a drawer; the list never carries an inline add form.
import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../testing/jsdom-env";

await bootJsdomEnvironment({ url: "http://localhost:4800/projects", matchMediaMatches: false });

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default as Record<string, unknown>;
const { GeofenceSection } = await import("./GeofenceSection");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const field = (messages.timesheets as { field: Record<string, string> }).field;

const FENCE = { id: "fence-1", kind: "circle" as const, center: { lat: 43.65, lng: -79.38 }, radiusM: 150, polygon: null, isActive: true };

async function render(canManage: boolean, posted: unknown[]) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    return Response.json({ geofences: [FENCE] });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GeofenceSection projectId="project-1" initial={[]} canManage={canManage} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    host,
    done: async () => {
      globalThis.fetch = prior;
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("geofences list in a table with Add geofence top right and no inline form", async (t) => {
  const view = await render(true, []);
  t.after(view.done);
  const section = view.host.querySelector("[data-drawer-sublist]")!;
  const header = section.firstElementChild!;
  assert.equal(header.lastElementChild?.textContent?.trim(), field.addGeofence, "the add action is pinned top right");
  assert.ok(section.querySelector("table")?.textContent?.includes("150 m"), "fences list in the table");
  assert.equal(view.host.querySelectorAll("input, textarea").length, 0, "the list carries no inline add form");
});

test("Add geofence opens a drawer that saves a circle and closes", async (t) => {
  const posted: unknown[] = [];
  const view = await render(true, posted);
  t.after(view.done);
  const add = view.host.querySelector("[data-sublist-action] button") as HTMLButtonElement;
  await act(async () => {
    add.click();
    await tick();
  });
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the add form lives in a drawer");
  const inputs = [...dialog.querySelectorAll("input")] as HTMLInputElement[];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(inputs[0], "43.7");
    inputs[0]!.dispatchEvent(new window.Event("input", { bubbles: true }));
    setter.call(inputs[1], "-79.4");
    inputs[1]!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  const save = [...dialog.querySelectorAll("button")].find((button) => button.textContent?.trim() === field.saveGeofence) as HTMLButtonElement;
  await act(async () => {
    save.click();
    await tick();
  });
  await tick();
  assert.deepEqual(posted, [{ projectId: "project-1", kind: "circle", center: { lat: 43.7, lng: -79.4 }, radiusM: 100, polygon: null }]);
});

test("a viewer without manage rights sees the list without an add action", async (t) => {
  const view = await render(false, []);
  t.after(view.done);
  assert.equal(view.host.querySelector("[data-sublist-action]"), null);
});
