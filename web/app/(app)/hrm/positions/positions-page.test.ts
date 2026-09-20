import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Text pins for the positions page's header action. The page was reviewed on
// production without any way to add a position; the fix is the house pattern —
// the primary action first in the page header through the shared Button, the
// create form inside the URL drawer — and these pins keep it that way.

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const form = readFileSync(new URL("./PositionCreateForm.tsx", import.meta.url), "utf8");

test("the header carries Add position first, then the strip, behind the manage ref", () => {
  const add = view.indexOf("widget('link-button'");
  const tabs = view.indexOf("widget('module-home-tabs'");
  assert.ok(add > 0 && tabs > add, "the primary action precedes the tab strip");
  // The shared header action (the Button rendered by the link-button widget
  // every other list page uses), opening the form through the URL so the
  // drawer is shareable and closes by navigation — no bespoke button.
  assert.match(view, /widget\('link-button', \{ href: f\('addHref'\), label: f\('addLabel'\), iconKey: 'plus' \}, f\('canManage'\)\)/);
  assert.match(view, /addHref: hrefFor\(effectiveDate, status, 'new'\)/, "the href keeps the as-of date and segment");
  assert.match(view, /canManage = can\(authz, 'hrm\.position\.manage'\)/, "the ref is the same grant the POST route enforces");
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

test("the create copy ships in every locale", () => {
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
