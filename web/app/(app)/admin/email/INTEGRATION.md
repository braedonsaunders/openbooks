# /admin/email ViewSpec integration handoff

Page: `web/app/(app)/admin/email/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the native page defines no local components — the entire
surface is the imported `EmailSettingsForm` client island, which the spec
path reuses whole through the widget below. Nothing is copied, nothing
needed moving.

Spec shape: `bare` layout (the page owns its own `PageContainer` shell the
way the platform hub does — `ListPageLayout` chrome would nest a second
shell), one `frame('page-container')` holding exactly the two native
children (a `pageHeader` and one `email-settings-form` widget). One new
widget, proposed below. No new viewspec vocabulary: `frame`,
`page-container`, `pageHeader` (with `back`), and `widgetBlock` all exist.

Why whole-island (not decomposed): `EmailSettingsForm` owns `useState`
(field values, the secret draft, `replaceSecret`, saving/testing flags),
fires `fetch` PUT/POST mutations against `/api/admin/email` and
`/api/admin/email/test`, looks up `EMAIL_PROVIDER_SPECS` client-side to
decide which provider field set and secret block to show, and toasts +
`router.refresh()` on save. The provider switch is a five-way conditional
pair (a Resend form vs an SMTP form vs …) — a spec `when` is presence,
never a choice between field sets. Decomposing it would render the wrong
provider's fields and strand the inputs from the state they edit (the
bank-feeds lesson). The LOADER makes every server-side decision the native
page made (the `admin.setup.manage` gate, the hub back label, the redacted
config read); the widget only renders.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed:

```tsx
import { EmailSettingsForm } from '../../app/(app)/admin/email/EmailSettingsForm'
```

Place the entry next to the other admin entries (no `email-settings` or
`EmailSettings` hit exists in the registry today):

```tsx
/* --- email settings ----------------------------------------------------------- */
/**
 * Email-delivery settings form: the whole EmailSettingsForm island — enable
 * toggle, provider picker, sender fields, provider-specific fields, sealed-
 * secret block, save, and the test-send box. NOT decomposable: everything
 * below the page shell owns useState (field values, the secret draft,
 * replaceSecret, saving/testing), fires fetch PUT/POST mutations, and
 * resolves EMAIL_PROVIDER_SPECS client-side to pick the field set. The
 * LOADER makes every server-side decision (permission gate, hub back
 * label, redacted config read); the widget only renders.
 *
 * EXACT prop shape: ONE prop — `initial`, the redacted
 * `OrgEmailConfigView` (secret ciphertext never leaves the engine module;
 * only `hasSecret` crosses) — passed exactly as the native page passes it:
 * `<EmailSettingsForm initial={config} />`. There is no wrapper bag; do
 * not add one.
 */
'email-settings-form': (props) => (
  <EmailSettingsForm
    initial={props.initial as ComponentProps<typeof EmailSettingsForm>['initial']}
  />
),
```

## 2. Slot proposals (none)

No slot is needed. Authz and the org id are consumed server-side by the
loader (`requirePermission('admin.setup.manage')`, then
`readOrgEmailConfigView(authz.user.orgId)`); only plain data (title,
description, back href/label, the redacted `initial` blob) crosses the
spec. The island persists mutations through `fetch` + the session cookie
inside the shared component. (Same division as bank-feeds §2.)

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/email',
  // Whole-island settings page: the loader resolves the manage gate, the
  // hub back label and the redacted org email config; EmailSettingsForm
  // renders the enable toggle, provider picker, sender fields, save, and
  // the test-send box. The page takes no query params, so a single default
  // render covers every branch the harness tenant can reach (see below).
  variants: [''],
  expect: 'main button',
  minMatches: 2,
},
```

Verified against `openbooks_sim_viewspec` (live psql, 2026-09-10):

- SIM org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a` (`SIM · Summit Ridge
  Construction`) has `settings->'email'` = NULL — the unconfigured branch.
- So `initial` is `{ hasSecret: false, updatedAt: <revision> }`: no
  provider is selected, so no provider field set and no secret block
  render — the `Replace` / `Keep existing credential` buttons and the SMTP
  boolean checkbox are all absent on BOTH paths (both derive `initial`
  from the same `readOrgEmailConfigView` call against the same row).
- The exactly-two `<button>` elements are `Save settings` and `Send test`
  (the `PageHeader` back control is a link, not a button). `minMatches: 2`
  is therefore exact, not a lower bound that hides a missing button.

GATES check: ONE server gate, in the LOADER before any query —
`requirePermission('admin.setup.manage')` (throws, not a render branch).
The harness user `viewspec@sim.test` is super-admin (`is_super_admin =
t`, verified), so the gate passes on both paths. No feature gate, no
`notFound`/redirect branch — the unconfigured state above renders the
form, never an error page, so the comparison is real.

No fixture rows are needed for the default render, and **no fixture id
block is claimed**: nothing is seeded. (Allocation table at the top of
`scripts/viewspec-fixtures.sql` checked, whole file grepped for `email` —
no existing email block to collide with; and none is added here.)

Uncovered branch (reported, not fixed): the CONFIGURED state — a provider
selected (provider field set renders) and `hasSecret: true` (the `set`
badge + `Replace` flow render instead of the bare secret input) — is
DB-driven, not query-driven, so no `variants` entry can reach it while the
SIM org's `settings.email` stays NULL. If the coordinator wants that
branch covered, the fixture is an `orgs.settings` merge needing NO fixed
ids (same `jsonb_set` shape as the §"feature switches" merge), e.g.
SMTP + dummy sealed-secret markers so `hasSecret` reads true; under that
state the entry above becomes `expect: 'main button', minMatches: 3`
(Save + Send test + Replace). I did NOT apply that merge — it mutates
shared SIM-org state the email worker/tests also read, so it is the
coordinator's call.

## 4. What the spec does NOT cover (nothing — full coverage)

- The loader (`loadEmailSettings`) copies the native permission gate,
  back-label lookup, and config read VERBATIM, including the hardcoded
  English title/description literals (the native page uses no `t()` for
  them — only `tHub('title')` for the back label, which the loader keeps).
  Zero new message keys are introduced.
- The spec introduces zero class strings of its own — the form island owns
  `max-w-2xl space-y-6` and every field class, and it renders from the
  shared component on both paths, so there is nothing to transcribe.
- `updatedAt` revision token passes through untouched for the API's CAS
  fence; the spec never reads it.
