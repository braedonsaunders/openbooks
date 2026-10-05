import { CommerceError } from "./errors.ts";
import type { ChannelWorkspaceTab, SalesChannelAdapter } from "./contracts.ts";

/**
 * The adapter registry: one adapter per storefront kind. Production adapters
 * arrive with later changes; tests register a test adapter through this same
 * registry, so the registry path the tests exercise is the production path.
 * Registering a second adapter for one kind refuses loudly — two translators
 * for one kind would make verification and settings validation ambiguous.
 */
const adapters = new Map<string, SalesChannelAdapter>();

export function registerChannelAdapter(adapter: SalesChannelAdapter): void {
  const kind = adapter.kind.trim();
  if (!kind) {
    throw new CommerceError(
      "channel_adapter_kind_blank",
      "A storefront adapter must name its channel kind.",
      "Give the adapter the storefront kind it translates, matching the sales_channels kind values.",
      { field: "kind" },
    );
  }
  if (adapters.has(kind)) {
    throw new CommerceError(
      "channel_adapter_duplicate",
      `A storefront adapter is already registered for kind "${kind}".`,
      "Register each storefront kind exactly once; extend the existing adapter instead of adding a second.",
      { field: "kind", status: 409 },
    );
  }
  adapters.set(kind, adapter);
}

export function channelAdapter(kind: string): SalesChannelAdapter {
  const adapter = adapters.get(kind);
  if (!adapter) {
    const known = registeredChannelKinds();
    throw new CommerceError(
      "channel_kind_unknown",
      known.length === 0
        ? `No storefront connector is registered for kind "${kind}", and no connectors are installed.`
        : `No storefront connector is registered for kind "${kind}". Installed: ${known.join(", ")}.`,
      known.length === 0
        ? "Install the storefront connector for this kind before connecting a channel of it."
        : `Connect a channel of an installed kind (${known.join(", ")}), or install the connector for "${kind}".`,
      { field: "kind" },
    );
  }
  return adapter;
}

export function registeredChannelKinds(): string[] {
  return [...adapters.keys()].sort();
}

/**
 * Workspace tabs contributed by one kind's adapter. A kind with no installed
 * connector contributes none — the workspace renders its built-in tabs
 * alone. This never refuses: verification and settings paths keep the
 * strict lookup above, but an uninstalled connector must not take down a
 * channel the operator is already inspecting.
 */
export function workspaceTabsFor(kind: string): ChannelWorkspaceTab[] {
  return adapters.get(kind)?.workspaceTabs() ?? [];
}
