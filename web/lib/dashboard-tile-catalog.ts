import "server-only";
import { WIDGETS } from "../app/(app)/dashboard/_widget-registry";
import dashboardMessages from "../messages/en/dashboard.json";

type Messages = { widgets?: Record<string, string>; catalog?: Record<string, string> };

function message(key: string, messages: Messages): string {
  const [section, name] = key.split(".") as ["widgets" | "catalog", string];
  return messages[section]?.[name] ?? name;
}

/**
 * Every home-dashboard tile a screen may embed with `dashboard-tiles`, with
 * its English label, description and grid size bounds. Availability per
 * reader is decided at render; this lists what exists.
 */
export function dashboardTileCatalog() {
  const messages = dashboardMessages as Messages;
  return Object.values(WIDGETS)
    .filter((widget) => !widget.id.startsWith("personal-"))
    .map((widget) => ({
      id: widget.id,
      category: widget.category,
      label: message(widget.labelKey, messages),
      description: message(widget.descriptionKey, messages),
      defaultSize: widget.defaultSize,
      minSize: widget.minSize,
      ...(widget.maxSize ? { maxSize: widget.maxSize } : {}),
    }));
}
