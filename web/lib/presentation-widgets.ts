import { HOME_ACCENTS, HOME_ICON_KEYS } from "../components/module-home/icon-keys";
import { WIDGETS as DASHBOARD_TILES } from "../app/(app)/dashboard/_widget-registry";

/**
 * The dashboard and presentation vocabulary an author composes screens from:
 * the house cockpit blocks plus data-only widgets whose every prop is plain
 * JSON. Native app page screens may use exactly these widgets; page layouts
 * may use them beside every other registered widget.
 *
 * Kept as data, beside the contracts the validator enforces, so the agent
 * vocabularies, the app screen allowlist and the docs read one list.
 */

export interface PresentationWidgetDoc {
  purpose: string;
  /** Prop name → type and meaning. */
  props: Record<string, string>;
  example: Record<string, unknown>;
}

export const PRESENTATION_WIDGETS: Readonly<Record<string, PresentationWidgetDoc>> = {
  "dashboard-tiles": {
    purpose:
      "Live home-dashboard tiles (cash, receivables, payables, revenue, approvals, charts) by catalog id, rendered with the reader's own permissions and feature gates; tiles the reader cannot see are omitted.",
    props: {
      widgets:
        "{ id: dashboard tile id (see dashboardTiles), w?: columns 1–12, h?: rows of 48px }[] — up to 24",
    },
    example: {
      kind: "widget",
      widget: "dashboard-tiles",
      props: {
        widgets: [
          { id: "kpi-cash-balance", w: 3 },
          { id: "kpi-open-receivables", w: 3 },
        ],
      },
    },
  },
  "kpi-strip": {
    purpose: "One horizontal row of compact KPI cards.",
    props: {
      items:
        '{ label: string, value: string (already formatted), tone?: "good" | "bad", suffix?: string }[]',
    },
    example: {
      kind: "widget",
      widget: "kpi-strip",
      props: {
        items: [
          { label: "Open", value: { $: "data.openCount" } },
          { label: "Overdue", value: { $: "data.overdueCount" }, tone: "bad" },
        ],
      },
    },
  },
  "trend-chart": {
    purpose: "Line or area chart over labelled periods.",
    props: {
      labels: "string[] — x-axis labels, one per point",
      series: '{ name: string, data: (number | null)[], color?: "#hex" }[]',
      area: "boolean — shade under the line",
      format: '"money" (default, org currency) | "count"',
      height: "number — pixels (default 200)",
    },
    example: {
      kind: "widget",
      widget: "trend-chart",
      props: {
        labels: { $: "data.months" },
        series: { $: "data.series" },
        area: true,
        format: "count",
      },
    },
  },
  "bar-chart": {
    purpose: "Grouped vertical bars, money values (budget vs actual, period comparisons).",
    props: {
      labels: "string[]",
      series: '{ name: string, data: number[], color?: "#hex" }[]',
      height: "number — pixels (default 240)",
    },
    example: {
      kind: "widget",
      widget: "bar-chart",
      props: { labels: { $: "data.labels" }, series: { $: "data.series" } },
    },
  },
  "donut-chart": {
    purpose: "Share-of-total donut with legend.",
    props: {
      data: "{ name: string, value: number }[]",
      format: '"money" (default) | "count" | "percent"',
      height: "number — pixels (default 220)",
    },
    example: {
      kind: "widget",
      widget: "donut-chart",
      props: { data: { $: "data.bySeverity" }, format: "count" },
    },
  },
  "score-gauge": {
    purpose: "Semicircular 0–100 score gauge.",
    props: {
      value: "number 0–100",
      label: "string — caption under the score",
      bands:
        "{ excellent: number, good: number, average: number } | null — tone cut-offs; null renders untoned",
      goodWhenHigh: "boolean (default true)",
      size: "number — pixels (default 200)",
    },
    example: {
      kind: "widget",
      widget: "score-gauge",
      props: {
        value: { $: "data.passRate" },
        label: "Pass rate",
        bands: { excellent: 90, good: 75, average: 60 },
      },
    },
  },
  "progress-bars": {
    purpose:
      "Labelled horizontal bars: each item's share of the largest, or progress toward its own max.",
    props: {
      items:
        '{ label: string, value: number, max?: number, tone?: "default" | "positive" | "warning" | "negative" | "muted", detail?: string }[]',
      format: '"money" (default) | "count" | "percent"',
    },
    example: {
      kind: "widget",
      widget: "progress-bars",
      props: { items: { $: "data.byProject" }, format: "count" },
    },
  },
  "live-directory": {
    purpose: "Grid of destination links, each with an optional live badge.",
    props: {
      items: `{ href: in-app path, label: string, iconKey: one of iconKeys, badge?: { value: string, hint?: string, tone?: "neutral" | "positive" | "warning" | "negative" } }[]`,
    },
    example: {
      kind: "widget",
      widget: "live-directory",
      props: { items: [{ href: "/projects", label: "Projects", iconKey: "briefcase" }] },
    },
  },
  "attention-list": {
    purpose: "A short list of items needing action, each linking to where it is handled.",
    props: {
      items: '{ tone: "negative" | "warning", text: string, href: in-app path }[]',
      allClear: "string — shown when items is empty",
    },
    example: {
      kind: "widget",
      widget: "attention-list",
      props: { items: { $: "data.attention" }, allClear: "Nothing needs attention" },
    },
  },
  "link-button": {
    purpose: "A button that navigates.",
    props: {
      href: "in-app path",
      label: "string",
      variant: '"default" | "outline" | "secondary" | "ghost" | "destructive" | "link"',
      size: '"sm" | "md" | "lg"',
      iconKey: '"plus" | "settings"',
    },
    example: {
      kind: "widget",
      widget: "link-button",
      props: { href: "/customers", label: "Customers", variant: "outline" },
    },
  },
};

/** Widgets a native app page screen may place. */
export const APP_SCREEN_WIDGETS: ReadonlySet<string> = new Set(Object.keys(PRESENTATION_WIDGETS));

/** House blocks for dashboards, with the vocabulary their properties take. */
export const DASHBOARD_COMPOSITION = {
  blocks: {
    "stat-tile":
      'KPI hero tile: { kind: "stat-tile", iconKey, accent, label, value, sub?, tone?: "default" | "positive" | "warning" | "negative" }. Values are display strings (format numbers and money in the data endpoint). Put several in a grid.',
    grid: 'Responsive layout: { kind: "grid", className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-4", blocks }. Use for tile rows and two-column bodies ("grid gap-6 lg:grid-cols-3" with a panel className "lg:col-span-2").',
    panel:
      'Titled card: { kind: "panel", title, iconKey?, hint?, className?, bodyClassName?, blocks }. Wrap charts, tables and lists in panels.',
    table:
      'Native table over an array: { kind: "table", rows: { $: "data.rows" }, rowKey: { $: "id" }, columns: [{ header, cell: { kind: "text" | "money" | "number" | "date" | "badge" | "link", field: { $: "rowField" } } }] }.',
    heading: 'Section heading: { kind: "heading", level: 2 | 3, content }.',
    text: 'Paragraph: { kind: "text", content, tone? }.',
  },
  iconKeys: [...HOME_ICON_KEYS],
  accents: [...HOME_ACCENTS],
  pattern:
    "A module landing: a grid of 3–4 stat-tiles, then a two-column grid with a wide panel holding a chart or table and a narrow panel holding a progress-bars or attention-list. One concept per panel; never stack unrelated tables.",
} as const;

const ENUMS: Record<string, Record<string, readonly string[]>> = {
  "link-button": {
    variant: ["default", "outline", "secondary", "ghost", "destructive", "link"],
    size: ["sm", "md", "lg", "icon"],
    iconKey: ["plus", "settings"],
  },
  "trend-chart": { format: ["money", "count"] },
  "donut-chart": { format: ["money", "count", "percent"] },
  "progress-bars": { format: ["money", "count", "percent"] },
};
const ITEM_ENUMS: Record<string, { prop: string; field: string; values: readonly string[] }> = {
  "kpi-strip": { prop: "items", field: "tone", values: ["good", "bad"] },
  "progress-bars": {
    prop: "items",
    field: "tone",
    values: ["default", "positive", "warning", "negative", "muted"],
  },
  "attention-list": { prop: "items", field: "tone", values: ["negative", "warning"] },
};

const isRef = (value: unknown) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof (value as { $?: unknown }).$ === "string";
const quoted = (values: readonly string[]) =>
  values.map((value) => JSON.stringify(value)).join(", ");

/**
 * Literal prop values a presentation widget cannot render: an unknown
 * dashboard tile, a size outside the grid, a value outside a closed set.
 * Bound values ({ "$": path }) are checked when they render, not here.
 */
export function presentationPropErrors(spec: unknown): string[] {
  const errors: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node))
      return node.forEach((child, index) => visit(child, `${path}.${index}`));
    if (!node || typeof node !== "object") return;
    const block = node as Record<string, unknown>;
    const name = typeof block.widget === "string" ? block.widget : null;
    const props =
      block.props && typeof block.props === "object" && !Array.isArray(block.props)
        ? (block.props as Record<string, unknown>)
        : null;
    if (name && props) {
      for (const [prop, values] of Object.entries(ENUMS[name] ?? {})) {
        const value = props[prop];
        if (value !== undefined && !isRef(value) && !values.includes(String(value)))
          errors.push(`${path}.props.${prop}: ${name} ${prop} must be one of ${quoted(values)}`);
      }
      const items = ITEM_ENUMS[name];
      const list = items ? props[items.prop] : undefined;
      if (items && Array.isArray(list))
        list.forEach((item, index) => {
          const value =
            item && typeof item === "object"
              ? (item as Record<string, unknown>)[items.field]
              : undefined;
          if (value !== undefined && !isRef(value) && !items.values.includes(String(value)))
            errors.push(
              `${path}.props.${items.prop}.${index}.${items.field}: must be one of ${quoted(items.values)}`,
            );
        });
      if (name === "dashboard-tiles" && Array.isArray(props.widgets)) {
        if (props.widgets.length > 24) errors.push(`${path}.props.widgets: at most 24 tiles`);
        props.widgets.forEach((tile, index) => {
          const at = `${path}.props.widgets.${index}`;
          const id =
            tile && typeof tile === "object" ? (tile as Record<string, unknown>).id : undefined;
          if (
            typeof id !== "string" ||
            !Object.hasOwn(DASHBOARD_TILES, id) ||
            id.startsWith("personal-")
          ) {
            errors.push(
              `${at}.id: unknown dashboard tile ${JSON.stringify(id)}; describe_page_layout_vocabulary lists dashboardTiles`,
            );
            return;
          }
          for (const dimension of ["w", "h"] as const) {
            const value = (tile as Record<string, unknown>)[dimension];
            if (
              value !== undefined &&
              (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 12)
            )
              errors.push(`${at}.${dimension}: must be a whole number from 1 to 12`);
          }
        });
      }
    }
    for (const [key, child] of Object.entries(block))
      if (key !== "props") visit(child, path ? `${path}.${key}` : key);
  };
  visit(spec, "");
  return errors;
}
