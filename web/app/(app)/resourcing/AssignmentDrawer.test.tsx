import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

const testState = { refusalBodies: [] as unknown[] };
(globalThis as Record<symbol, unknown>)[Symbol.for("openbooks.assignment-drawer-test")] = testState;
await bootJsdomEnvironment({ url: "http://localhost/resourcing/assignments", event: "jsdom" });

const React = await import("react");
Object.assign(globalThis, { React });
stubModules({
  navigation: { pathname: "/resourcing/assignments" },
  intl: `export function useTranslations(){return (key)=>key}`,
  extra: {
    "next-intl": `export function useTranslations(){return (key)=>key}`,
    "@openbooks/ui": `
      const R=globalThis.React
      export function Select({children,...props}){return R.createElement('select',props,children)}
      export function Input(props){return R.createElement('input',props)}
      export function Button({children,...props}){return R.createElement('button',props,children)}
      export function Badge({children,...props}){return R.createElement('span',props,children)}
    `,
    "../../../components/custom-field-inputs": `export function CustomFieldInputs(){return null}`,
    "../../../components/dirty-url-drawer": `
      export function DirtyUrlDrawer({children}){return children}
      export function useDirtyUrlDrawer(){return async()=>{}}
    `,
    "../../../components/drawer-tab-strip": `
      const R=globalThis.React
      export function DrawerTabStrip({ariaLabel,activeKey,onSelect,tabs}){
        return R.createElement('nav',{'aria-label':ariaLabel},...tabs.map(tab=>R.createElement('button',{key:tab.key,type:'button','aria-pressed':activeKey===tab.key,onClick:()=>onSelect(tab.key)},tab.label)))
      }
    `,
    "../../../components/date-field": `
      const R=globalThis.React
      export function DateField(props){return R.createElement('input',{...props,type:'date'})}
    `,
    "../../../lib/confirm": `export async function confirmDialog(){return false}`,
    "../../../lib/api-error": `
      const state=globalThis[Symbol.for('openbooks.assignment-drawer-test')]
      export function refusalMessageFromBody(body,options){state.refusalBodies.push(body);return options.fallback}
    `,
    "../../../lib/format": `export function formatTicketHours(value){return String(value)}`,
  },
});

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { AssignmentDrawer } = await import("./AssignmentDrawer");
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function drawerProps(people: { id: string; name: string; jobTitle: string | null }[]) {
  return {
    assignment: null,
    createMode: true,
    prefill: {
      projectId: "project-1",
      employeePartyId: "",
      jobTitle: "",
      weekStart: "2026-10-19",
      plannedHours: "8.0000",
    },
    projectLabel: null,
    people,
    projects: [{ id: "project-1", name: "Project" }],
    items: [],
    tasks: [],
    capacity: null,
    actuals: { hours: "0.0000", entries: [] },
    absenceRows: [],
    customDefs: [],
    remountKey: "new-assignment",
    closeHref: "/resourcing/assignments",
    canManage: true,
  } as unknown as Parameters<typeof AssignmentDrawer>[0];
}

async function mount(props: Parameters<typeof AssignmentDrawer>[0]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(AssignmentDrawer, props));
    await tick();
  });
  return {
    host,
    async close() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
}

test("job-title mode remains selected when there are no job titles or its placeholder is chosen", async (t) => {
  const empty = await mount(drawerProps([]));
  t.after(empty.close);
  let selects = [...empty.host.querySelectorAll("select")];
  const subjectType = selects[1]!;
  await selectValue(subjectType, "job-title");
  assert.equal(subjectType.value, "job-title");
  assert.equal(
    [...empty.host.querySelectorAll("select")][2]?.options[0]?.textContent,
    "assignments.chooseJobTitle",
  );

  const withTitles = await mount(
    drawerProps([{ id: "person-1", name: "Alex", jobTitle: "Analyst" }]),
  );
  t.after(withTitles.close);
  selects = [...withTitles.host.querySelectorAll("select")];
  const titledSubjectType = selects[1]!;
  await selectValue(titledSubjectType, "job-title");
  assert.equal(titledSubjectType.value, "job-title");
  const jobTitlePicker = [...withTitles.host.querySelectorAll("select")][2]!;
  assert.equal(jobTitlePicker.value, "Analyst");
  await selectValue(jobTitlePicker, "");
  assert.equal(titledSubjectType.value, "job-title");
  assert.equal(jobTitlePicker.options[0]?.textContent, "assignments.chooseJobTitle");
});

test("non-JSON save refusals still reach the shared refusal formatter", async (t) => {
  const mounted = await mount({
    ...drawerProps([{ id: "person-1", name: "Alex", jobTitle: "Analyst" }]),
    prefill: {
      projectId: "project-1",
      employeePartyId: "person-1",
      jobTitle: "",
      weekStart: "2026-10-19",
      plannedHours: "8.0000",
    },
  } as Parameters<typeof AssignmentDrawer>[0]);
  t.after(mounted.close);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html>upstream error</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  testState.refusalBodies = [];
  try {
    const save = [...mounted.host.querySelectorAll("button")].find(
      (button) => button.textContent === "assignments.save",
    );
    assert.ok(save, mounted.host.innerHTML);
    await act(async () => {
      save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
    assert.equal(testState.refusalBodies.length, 1);
    assert.deepEqual(testState.refusalBodies[0], { remedy: undefined });
    assert.match(
      mounted.host.querySelector('[role="alert"]')?.textContent ?? "",
      /assignments.saveFailed/,
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});
