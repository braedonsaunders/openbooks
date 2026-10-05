# Channel workspace tab contract

Channel detail pages (`web/app/(app)/channels/[id]/`) render a shared
workspace shell (`ChannelWorkspace.tsx`) plus one tab component per tab.
Each channel kind contributes extra tabs through a channel adapter
(`engine/src/commerce/contracts.ts`).

## Tab identity and fallback

- Tab ids are stable strings: `overview`, `activity`, `settings`, plus
  adapter tabs prefixed with `adapter:` (for example `adapter:products`).
- `workspaceTabsFor(kind)` returns the three built-in tabs when no adapter
  is registered for `kind`. Unknown kinds always render; they never crash.

## Adapter registration timing

Adapters are installed lazily through the public barrel
(`installedChannelKinds()` / `ensureInstalledChannelKinds()`), not at
import time. `ChannelWorkspace` ensures the installed kinds before
resolving tabs, so adapter tabs (Products, Locations) render on a fresh
server process exactly as they do on a warm one.

## Tab labels

Adapter tab labels are catalog keys relative to the `channels` message
namespace (for example `tabs.products`, resolved with the root
translator). A label that resolves to a raw key path in any locale is a
defect in the adapter declaration, not in the shell.
