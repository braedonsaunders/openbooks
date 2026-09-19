import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Native composition contract for the Employment tab on the employee
// drawer. Runs without dependencies: it reads the maintained sources and
// proves the tab rides the existing PartyDrawer tab mechanism (never a
// parallel page), resolves as-of state server-side through the canonical
// read service, renders computed refusals as refusals, and lists the
// employment's change requests with their revision binding and approval
// link — every label from catalogs.
const tab = readFileSync(new URL("./EmploymentTab.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../../api/hrm/employments/[id]/route.ts", import.meta.url), "utf8");
const drawer = readFileSync(new URL("../parties/PartyDrawer.tsx", import.meta.url), "utf8");
const entityView = readFileSync(new URL("../entities/[role]/view.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../messages/en/hrm.json", import.meta.url), "utf8");
const partyStrings = readFileSync(new URL("../../../messages/en/parties.json", import.meta.url), "utf8");

test("employment tab rides the drawer tab mechanism, never a parallel page", () => {
  assert.match(drawer, /'employment'/, "employment joins the PartyTab union");
  assert.match(drawer, /showEmploymentTab/, "one predicate gates the tab button and the deep-link");
  assert.match(drawer, /initialTab === 'employment' && !showEmploymentTab/, "a stale employment deep-link falls back to overview");
  assert.match(drawer, /label: t\('tabs\.employment'\)/, "tab label resolves from the catalog");
  assert.match(drawer, /<EmploymentTab employmentId/, "single employment renders the native tab");
  assert.match(drawer, /noRecord\.title/, "zero employments render the explicit no-record state");
  assert.match(drawer, /multiple\.title/, "several employments refuse with the ambiguity state");
  assert.ok(!/app\/\(app\)\/hrm\/page/.test(drawer), "no parallel employment page is linked");
  assert.ok(partyStrings.includes('"employment": "Employment"'), "drawer tab label ships in en/parties");
});

test("entity loader admits the tab and resolves scoped employments behind the double gate", () => {
  assert.match(entityView, /requestedPartyTab === 'employment'/, "?partyTab=employment survives the allowlist");
  assert.match(entityView, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "loader checks the Features switch");
  assert.match(entityView, /can\(authz, 'hrm\.employment\.read'\)/, "loader checks the employment read grant");
  assert.match(entityView, /findEmploymentsByParty/, "party resolves through the canonical read service");
  assert.match(entityView, /hrm: canReadHrm && role === 'employee'/, "only gated employee drawers carry employments");
});

test("as-of resolution is server-resolved with res.ok before parsing", () => {
  assert.match(tab, /fetch\(`\/api\/hrm\/employments\/\$\{employmentId\}\?effectiveDate=\$\{date\}`\)/, "date picker refetches from the record API");
  assert.match(tab, /if \(!res\.ok\)/, "API failure is detected with res.ok before parsing");
  assert.match(tab, /readApiErrorMessage/, "error bodies surface the server message with a status fallback");
  assert.match(tab, /requestId\.current/, "a sequence guard drops stale as-of responses");
  assert.match(tab, /type="date"/, "effective date is a native labeled date control");
  assert.match(tab, /htmlFor="employment-asof-date"/, "date control has an associated label");
  assert.match(tab, /toast\.error/, "load failures toast through the existing channel");
  assert.match(tab, /role="alert"/, "load failures also render an inline error");
});

test("episodes, stamps, and assignments render the recorded-vs-effective distinction", () => {
  assert.match(tab, /episodes\.title/, "episodes section carries the catalog heading");
  assert.match(tab, /episodes\.effective/, "episode rows name their effective window");
  assert.match(tab, /episodes\.recorded/, "episode rows name their recorded window");
  assert.match(tab, /episodes\.empty/, "an employment with no versions states so explicitly");
  assert.match(tab, /assignments\.empty/, "an as-of without assignments states so explicitly");
  assert.match(tab, /assignment\.fte/, "FTE renders as the exact stored text, never through Number");
  assert.ok(!/Number\(.*fte/i.test(tab), "no numeric coercion touches FTE");
});

test("computed refusals render as refusals with their code and remedy", () => {
  assert.match(tab, /asOfRefusal/, "the record envelope's refusal leg is rendered");
  assert.match(tab, /asOf\.refusalTitle/, "refusal panel carries the catalog heading");
  assert.match(tab, /asOfRefusal\.code/, "refusal panel names the refusal code");
  assert.match(tab, /asOfRefusal\.message/, "refusal panel carries the server remedy verbatim");
});

test("change requests list status, revision binding, and the approval link", () => {
  assert.match(tab, /changeRequests\.title/, "requests section carries the catalog heading");
  assert.match(tab, /bindingValue/, "rows bind the request revision to the employment revision");
  assert.match(tab, /statusNames\./, "status renders through catalog labels");
  assert.match(tab, /href="\/approvals"/, "bound runs link to the native approvals surface");
  assert.match(tab, /viewInApprovals/, "approval link labels the interim destination honestly");
  assert.match(tab, /noRun/, "drafts state their lack of a run instead of a dead link");
  assert.match(tab, /changeRequests\.empty/, "an employment with no requests states so explicitly");
});

test("record API guards, validates, and maps refusals to coded errors", () => {
  assert.match(route, /guardFeaturePermission\('hrm\.employment\.read', 'hrm'\)/, "route requires the grant plus the switch");
  assert.match(route, /isUuid\(id\)/, "employment id is validated before the service runs");
  assert.match(route, /effectiveDate must be YYYY-MM-DD/, "effective date is validated before the service runs");
  assert.match(route, /getEmploymentRecord/, "record resolves through the canonical read service alone");
  assert.match(route, /HrmAuthorizationError[\s\S]*?status: 403/, "denial is a 403 carrying the uniform message");
  assert.match(route, /EmploymentReadError \|\| error instanceof TemporalError/, "computed refusals are 422s with code and remedy");
  assert.match(route, /await res\.json|return NextResponse\.json\(\{ record \}\)/, "success returns the envelope");
  assert.ok(!/from worker_employments/.test(route), "route issues no direct table reads");
});

test("employment copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "noRecord",
    "multiple",
    "refusalTitle",
    "bindingValue",
    "viewInApprovals",
    "noRun",
    "on_leave",
    "pending_approval",
  ]) {
    assert.ok(strings.includes(`"${key}"`), `en/hrm carries ${key}`);
  }
});
