import type { LineGridColumn } from "../line-grid";

/** Native prepaid fields shared by bill and journal line grids. */
export function amortizationLineColumns<Row extends Record<string, unknown>>(
  templates: readonly { id: string; label: string }[] | undefined,
  translate: (key: string) => string,
): LineGridColumn<Row>[] {
  if (!templates) return [];
  const hasTemplate = (row: Row) => String(row.amortizationTemplateId ?? "") !== "";
  return [
    {
      key: "amortizationTemplateId",
      label: translate("lineTemplate"),
      help: translate("lineTemplateHelp"),
      width: "180px",
      type: "select",
      options: [
        { value: "", label: translate("lineNoTemplate") },
        ...templates.map((template) => ({ value: template.id, label: template.label })),
      ],
    },
    {
      key: "amortizationStartOn",
      label: translate("lineServiceStart"),
      width: "130px",
      type: "date",
      isCellEditable: hasTemplate,
    },
    {
      key: "amortizationEndOn",
      label: translate("lineServiceEnd"),
      width: "130px",
      type: "date",
      isCellEditable: hasTemplate,
    },
  ];
}
