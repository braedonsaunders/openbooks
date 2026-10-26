import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESENTATION_WIDGETS, presentationPropErrors } from "./presentation-widgets";
import { WIDGET_CONTRACTS } from "../components/viewspec/widget-contracts";

test("literal presentation props outside their closed sets are refused; bound values are not judged", () => {
  const body = [
    {
      kind: "widget",
      widget: "dashboard-tiles",
      props: {
        widgets: [
          { id: "kpi-cash-balance", w: 3 },
          { id: "kpi-nonsense" },
          { id: "kpi-open-payables", w: 20 },
        ],
      },
    },
    {
      kind: "panel",
      title: "Links",
      blocks: [
        {
          kind: "widget",
          widget: "link-button",
          props: { href: "/x", label: "X", variant: "primary" },
        },
      ],
    },
    {
      kind: "widget",
      widget: "kpi-strip",
      props: {
        items: [
          { label: "A", value: "1", tone: "warning" },
          { label: "B", value: "2", tone: { $: "data.tone" } },
        ],
      },
    },
    {
      kind: "widget",
      widget: "donut-chart",
      props: { data: { $: "data.slices" }, format: { $: "data.format" } },
    },
  ];
  assert.deepEqual(presentationPropErrors({ body }), [
    'body.0.props.widgets.1.id: unknown dashboard tile "kpi-nonsense"; describe_page_layout_vocabulary lists dashboardTiles',
    "body.0.props.widgets.2.w: must be a whole number from 1 to 12",
    'body.1.blocks.0.props.variant: link-button variant must be one of "default", "outline", "secondary", "ghost", "destructive", "link"',
    'body.2.props.items.0.tone: must be one of "good", "bad"',
  ]);
});

test("every documented presentation prop is one the widget reads", () => {
  for (const [name, doc] of Object.entries(PRESENTATION_WIDGETS)) {
    const contract = WIDGET_CONTRACTS[name];
    assert.ok(contract, `${name} is registered`);
    for (const prop of Object.keys(doc.props))
      assert.ok(contract.open || contract.props.includes(prop), `${name} reads ${prop}`);
  }
});
