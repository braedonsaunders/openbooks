import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Text pins for the positions page's header action. The page was reviewed on
// production without any way to add a position; the fix is the house pattern —
// the primary action first in the page header through the shared Button, the
// create form inside the URL drawer — and these pins keep it that way.

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const button = readFileSync(new URL("./AddPositionButton.tsx", import.meta.url), "utf8");
const form = readFileSync(new URL("./PositionCreateForm.tsx", import.meta.url), "utf8");
const widgets = readFileSync(new URL("../../../../components/viewspec/widgets-hrm.tsx", import.meta.url), "utf8");
const names = readFileSync(new URL("../../../../components/viewspec/registry-names.ts", import.meta.url), "utf8");

test("the header carries Add position first, then the strip, behind the manage ref", () => {
  const add = view.indexOf("widget('hrm-add-position-button'");
  const tabs = view.indexOf("widget('module-home-tabs'");
  assert.ok(add > 0 && tabs > add, "the primary action precedes the tab strip");
  assert.match(view, /widget\('hrm-add-position-button', \{ basePath: data\.basePath, label: data\.addLabel \}, f\('canManage'\)\)/);
  assert.match(view, /canManage = can\(authz, 'hrm\.position\.manage'\)/, "the ref is the same grant the POST route enforces");
});

test("the button is the shared Button and opens the form through the URL", () => {
  assert.match(button, /from '@openbooks\/ui'/);
  assert.match(button, /<Button onClick=\{open\}>/);
  assert.match(button, /params\.set\('position', 'new'\)/, "the drawer is shareable and closes by navigation");
  assert.doesNotMatch(button, /className="[^"]*(bg-|rounded-|px-)/, "no bespoke button styling");
});

test("the create form uses the house form primitives and the real API", () => {
  for (const primitive of ["Button", "Input", "Label", "Select", "Textarea"]) {
    assert.match(form, new RegExp(`\\b${primitive}\\b`), `${primitive} from @openbooks/ui`);
  }
  assert.match(form, /fetch\('\/api\/hrm\/positions', \{\s*method: 'POST'/);
  assert.match(form, /readApiErrorMessage\(res, labels\.failed\)/, "a refusal is shown, never swallowed");
  assert.match(sections, /drawer\.create \? \(\s*<PositionCreateForm/, "the URL drawer hosts the form");
  assert.match(view, /sp\.position === 'new' && canManage/, "only a manager gets the form");
});

test("the widget is registered once and its copy ships in every locale", () => {
  assert.match(widgets, /'hrm-add-position-button': \(props\) =>/);
  assert.match(names, /'hrm-add-position-button',/);
  for (const locale of ["de", "en", "es", "fr", "ja", "pt-BR", "zh"]) {
    const catalog = JSON.parse(readFileSync(new URL(`../../../../messages/${locale}/hrm.json`, import.meta.url), "utf8")) as {
      positions: { add?: string; create?: Record<string, string> };
    };
    assert.ok(catalog.positions.add, `${locale} carries positions.add`);
    for (const key of ["title", "code", "titleField", "employer", "department", "noDepartment", "plannedFte", "status", "effectiveFrom", "reason", "reasonPlaceholder", "submit", "failed"]) {
      assert.ok(catalog.positions.create?.[key], `${locale} carries positions.create.${key}`);
    }
  }
});
