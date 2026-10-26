export type ChannelSection = "overview" | "orders" | "exceptions" | "posting";
export type ChannelTab = { href: string; label: string; active: boolean; count?: number };

export function channelTabs(
  t: (key: string) => string,
  active: ChannelSection,
  exceptionCount: number,
): ChannelTab[] {
  return [
    { href: "/channels", label: t("tabs.overview"), active: active === "overview" },
    { href: "/channels/orders", label: t("tabs.orders"), active: active === "orders" },
    {
      href: "/channels/exceptions",
      label: t("tabs.exceptions"),
      active: active === "exceptions",
      count: exceptionCount,
    },
    { href: "/channels/posting", label: t("tabs.posting"), active: active === "posting" },
  ];
}
