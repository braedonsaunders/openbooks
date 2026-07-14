# Internationalization

Every user-facing string in the web app goes through next-intl. English is
the source language; every shipped locale ships complete. This document is
the working convention — AGENTS.md makes it non-negotiable.

## Architecture

- **Locale resolution** (`web/lib/locale.ts`): `users.locale` (personal
  choice, set in the account menu) → `orgs.settings.defaultLocale` (tenant
  default, set in Admin → Company & Accounting) → `en`. No locale in the URL.
- **Request config** (`web/i18n/request.ts`): loads the locale's catalogs
  deep-merged over English, so a missing translation renders English rather
  than a raw key. That fallback is a safety net, not a licence to ship
  untranslated keys.
- **Shipped locales** (`web/i18n/config.ts`): `en`, `fr`, `es`. Adding one =
  new entry in `LOCALES`, new `web/messages/<code>/` directory with every
  namespace translated, new loader entry in `request.ts`, new index file
  (copy `messages/en/index.ts`).
- **Catalogs** (`web/messages/<locale>/<namespace>.json`): one namespace per
  module (`ap.json`, `reports.json`, …) plus `common` (generic actions/
  labels/statuses/feedback), `ui` (design-system + list/table chrome), `nav`
  (sidebar registry), `shell` (app chrome), `login`. Each locale directory
  has an `index.ts` importing every namespace — a new namespace must be added
  to **every** locale's index and directory.

## Converting / writing components

Server components (async, no `'use client'`):

```tsx
import { getTranslations } from 'next-intl/server'
const t = await getTranslations('ap')
<PageHeader title={t('list.title')} />
```

Client components:

```tsx
import { useTranslations } from 'next-intl'
const t = useTranslations('ap.billDrawer')
<Button>{saving ? t('saving') : t('save')}</Button>
```

Page metadata — static `metadata` exports with copy become:

```tsx
export async function generateMetadata() {
  const t = await getTranslations('ap')
  return { title: t('list.metaTitle') }
}
```

Module-level constants that carry labels (`const COLUMNS = [{ label: 'Date' }]`)
cannot call hooks — store message **keys** in the constant and translate at
the render site (`t(col.labelKey)`), or build the array inside the component
with `useMemo(() => [...], [t])`.

## Message rules

- Keys are camelCase, grouped by surface: `list.title`, `drawer.postAction`,
  `errors.periodClosed`. Never reuse one key for two meanings.
- Interpolation over concatenation: `"showing {from}–{to} of {total}"`, never
  `t('showing') + from + …`. Plurals use ICU:
  `"{count, plural, one {# line} other {# lines}}"`. Rich text (embedded
  `<strong>` etc.) uses `t.rich`.
- Reuse `common.*` before minting a new key (`common.actions.save`,
  `common.labels.status`, `common.status.posted`, `common.feedback.saveFailed`,
  `common.confirm.*`). If a generic string is missing from `common`, add it to
  your module namespace — `common`, `ui`, and `nav` change only in dedicated,
  deliberate edits.
- English source lives in `web/messages/en/`. **Every key added to `en` must
  land in `fr` and `es` in the same change** — translated, not copied.

## What gets translated

JSX text, `title`/`placeholder`/`aria-label`/`alt` attributes, toast
messages, confirm dialogs, empty/loading/error states, table headers, select
options, badge/status labels for enum values, page metadata titles.

## What does NOT get translated

- Data from the database: party names, memos, account names, document
  numbers, custom record/field names, org-customized nav labels.
- Codes and identifiers: currency/country ISO codes, permission keys, enum
  values sent to APIs, `console.*`/server log output.
- API route error payloads (technical/validation detail) — the client wraps
  failures in a translated toast and may append the server detail verbatim.
- Number/date rendering: stays in `web/lib/format.ts` (en-CA digits and
  medium dates) so ledgers read identically across locales. Localizing
  formats is a deliberate future change to `format.ts`, not per-component
  `toLocaleString` calls.
