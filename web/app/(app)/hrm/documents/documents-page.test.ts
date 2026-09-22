import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract coverage for /hrm/documents without booting Next: source
 * assertions over the page shell (gate placement, metadata,
 * search-params passthrough) and the loader/spec split between the
 * view, the loader lib, and the shared drawer/generate components.
 */

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/documents-home.ts", import.meta.url), "utf8");

test("documents page carries the gate where the route-gate scanner reads it", () => {
  assert.match(loader, /requirePermission\('hrm\.documents\.read'\)/, "the page enforces the documents read grant");
  assert.match(loader, /isFeatureEnabled\(gate\.user\.orgId, 'hrm'\)/, "the page enforces the hrm switch with a 404");
  assert.match(loader, /isFeatureEnabled\(gate\.user\.orgId, 'hrmDocuments'\)/, "the page enforces the documents switch with a 404");
  assert.match(page, /loadDocumentsPage\(sp\)/, "the page renders only after the view gate resolves");
  assert.match(page, /searchParams=\{sp\}/, "the query string reaches the loader and the spec host");
  assert.match(page, /trusted \/>/, "the view spec is trusted output, never raw user input");
  assert.match(page, /generateMetadata/, "tab metadata resolves the translated title");
});

test("documents spec composes shared primitives: tiles, filter chips, table, drawer", () => {
  assert.match(view, /route: '\/hrm\/documents'/, "the spec names its own route for the registry");
  assert.match(view, /statTile\(\{/, "the four tiles render through the shared stat tile");
  assert.match(view, /widgetBlock\('filter-chips'/, "segments render through the shared filter chips");
  assert.match(view, /paramKey: 'status'/, "segments filter over the status search param");
  assert.match(view, /table\(\{/, "the register renders through the shared table block");
  assert.match(view, /variant: 'app'/, "the list uses the shared app table primitives");
  assert.match(view, /badge\(item\('statusLabel'\)/, "status renders through the shared badge cell");
  assert.match(view, /link\(item\('title'\), item\('href'\)\)/, "the title opens the drawer through the row href");
  assert.match(view, /widgetBlock\('hrm-documents-drawer'/, "the drawer renders through the shared widget");
  assert.match(view, /widgetBlock\('hrm-documents-generate-dialog'/, "the generate dialog renders through the shared widget");
  assert.match(view, /module-home-tabs/, "the header carries the route-tab strip");
  assert.match(view, /setup-section.*hrm-document-templates/, "templates configure as a rehomed setup section");
  assert.match(view, /setup-section.*hrm-document-categories/, "categories configure as a rehomed setup section");
  assert.match(view, /setup-section.*hrm-retention-schedules/, "schedules configure as a rehomed setup section");
  assert.match(sections, /UrlDrawer/, "the drawer and dialog close by navigation");
  assert.ok(!sections.includes('<table'), "no hand-rolled table remains in the documents sections");
});

test("segments filter server-side and rows resolve through the read service", () => {
  assert.match(loader, /listDocuments\(\{/, "segments and rows resolve through the canonical documents read service");
  assert.match(loader, /getDocumentDetail\(\{/, "the drawer resolves one document through the same service");
  assert.match(loader, /listTemplates\(\{/, "the generate dialog resolves templates through the same service");
  assert.match(loader, /listCategories\(\{/, "category labels resolve through the category vocabulary");
  assert.match(loader, /sp\.status/, "the active segment comes from the query string");
  assert.match(loader, /sp\.document/, "the open document comes from the query string");
  assert.match(loader, /sp\.generate/, "the generate dialog opens through the query string");
  assert.match(loader, /segmentOptions/, "filter options resolve in the loader with counts");
  assert.match(loader, /currentParams/, "the query string survives a segment change");
  assert.match(loader, /statusVariant/, "badge presentation resolves in the loader, never in render");
  assert.match(loader, /hrmPeopleViewTabs/, "Documents rides the People viewTabs so it stays findable after leaving the group strip");
  assert.match(loader, /closeHref/, "the drawer closes by navigation to the segment href");
  assert.ok(!/from hrm_document_signers/.test(loader), "loader issues no direct signer-table reads");
  assert.ok(!/token_hash/.test(loader), "loader never touches token hashes");
  assert.ok(!/evidence/.test(loader), "loader never touches signature evidence");
});

test("drawer islands post through the document routes with refusals intact", () => {
  assert.match(sections, /`\$\{base\}\/send`/, "send posts through the send route");
  assert.match(sections, /`\$\{base\}\/remind`/, "remind posts through the remind route");
  assert.match(sections, /`\$\{base\}\/void`/, "void posts through the void route");
  assert.match(sections, /`\$\{base\}\/hold`/, "hold posts through the hold route");
  assert.match(sections, /\/api\/hrm\/documents\?mode=preview/, "merge preview resolves without writing");
  assert.match(sections, /\/api\/hrm\/documents\?mode=generate/, "generate posts through the documents route");
  assert.match(sections, /readApiErrorMessage/, "islands render refusals, never swallow them");
  assert.match(sections, /!res\.ok/, "error bodies are checked before they are parsed");
  assert.match(sections, /from '@openbooks\/ui'/, "forms use the house primitives");
  assert.ok(!sections.includes('orgId') && !sections.includes('actorId'), "no org, user, or Authz crosses into the client");
});
