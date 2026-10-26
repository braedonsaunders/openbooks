import type { CellSpec } from "@braedonsaunders/appkit-viewspec";
import { InlineCellView } from "./cell-leaves";
import { WidgetBlockView } from "./widget-slot";

/**
 * A spec cell. Widget cells resolve through the server widget registry; every
 * other kind renders through the shared inline renderers in cell-leaves.
 */
export function CellView({ spec, scope }: { spec: CellSpec; scope: unknown }) {
  if (spec.kind === "widget") {
    return <WidgetBlockView name={spec.widget} props={spec.props ?? {}} scope={scope} />;
  }
  return <InlineCellView spec={spec} scope={scope} />;
}
