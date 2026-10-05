# Channel workspace tab contract

Channel detail pages (`web/app/(app)/channels/[id]/`) render a shared
workspace shell (`ChannelWorkspace.tsx`) plus one tab component per tab.
Each channel kind contributes extra tabs through a channel adapter
(`engine/src/commerce/adapters.ts`, types in `contracts.ts`).

## Tab identity and fallback

- Tab ids are stable strings: `overview`, `activity`, `settings`, plus
  adapter tabs prefixed with `adapter:` (for example `adapter:products`).
- `workspaceTabsFor(kind)` returns only the adapter's own tabs, or `[]`
  when no connector is installed for the kind. It never refuses: the shell
  always renders the three built-in tabs and adds whatever the adapter
  contributes. An adapter key the channel's own adapter did not contribute
  falls back to overview.

## Adapter registration timing

Connectors register on demand per process, never at import time.
`ensureShopifyAdapterRegistered()` (re-exported through the public
barrel) installs the Shopify connector and silently keeps the existing
registration on a repeat call, so it is safe before every lookup.
`ChannelWorkspace` calls it before `workspaceTabsFor`: without that call
a fresh server process renders only the built-in tabs until an unrelated
request happens to register first. Unknown kinds keep the three-tab
fallback.

## Tab labels

Adapter tab labels are fully namespaced catalog keys (for example
`channels.tabs.products`). The workspace translator is scoped to the
`channels` catalog, so the shell strips the `channels.` prefix before
resolving and renders the key path itself when no entry matches. A raw
key path on screen is a defect in the adapter declaration or the catalog,
never in the shell.
