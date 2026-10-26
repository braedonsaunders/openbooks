import type { ComponentProps } from "react";
import { EquityAsOfControl } from "../../app/(app)/equity/AsOfControl";
import { EquityCapTablePanel } from "../../app/(app)/equity/CapTablePanel";
import { NewRecordDrawer } from "../../app/(app)/equity/NewRecordDrawer";
import { EquityActivityList, EquityOwnership } from "../../app/(app)/equity/OverviewSections";
import { EquityRoundsPanel } from "../../app/(app)/equity/RoundsPanel";
import { EquityRunsPanel } from "../../app/(app)/equity/RunsPanel";
import { EquitySecuritiesPanel } from "../../app/(app)/equity/SecuritiesPanel";
import { SecurityDrawer } from "../../app/(app)/equity/SecurityDrawer";
import {
  EquityClassesPanel,
  EquityPlansPanel,
  EquityStakeholdersPanel,
} from "../../app/(app)/equity/StructurePanels";
import { EquityWaterfallPanel } from "../../app/(app)/equity/WaterfallPanel";
import { str, type WidgetRenderer } from "./widget-props";

/** Equity & cap table adapters: compose the native workspace components without changing their props. */
export const EQUITY_WIDGETS = {
  "equity-as-of": (props) => {
    const control = props.control as ComponentProps<typeof EquityAsOfControl>["control"] | null;
    return control ? (
      <EquityAsOfControl control={control} compact={props.compact !== false} />
    ) : null;
  },
  "equity-ownership": (props) => (
    <EquityOwnership
      slices={(props.slices as ComponentProps<typeof EquityOwnership>["slices"]) ?? []}
      empty={str(props, "empty") ?? ""}
    />
  ),
  "equity-activity": (props) => (
    <EquityActivityList
      items={(props.items as ComponentProps<typeof EquityActivityList>["items"]) ?? []}
      empty={str(props, "empty") ?? ""}
    />
  ),
  "equity-cap-table": (props) => (
    <EquityCapTablePanel
      view={(props.view as ComponentProps<typeof EquityCapTablePanel>["view"]) ?? null}
    />
  ),
  "equity-securities": (props) => (
    <EquitySecuritiesPanel
      view={(props.view as ComponentProps<typeof EquitySecuritiesPanel>["view"]) ?? null}
    />
  ),
  "equity-rounds": (props) => (
    <EquityRoundsPanel
      view={(props.view as ComponentProps<typeof EquityRoundsPanel>["view"]) ?? null}
    />
  ),
  "equity-waterfall": (props) => (
    <EquityWaterfallPanel
      view={(props.view as ComponentProps<typeof EquityWaterfallPanel>["view"]) ?? null}
    />
  ),
  "equity-runs": (props) => (
    <EquityRunsPanel
      view={(props.view as ComponentProps<typeof EquityRunsPanel>["view"]) ?? null}
    />
  ),
  "equity-classes": (props) => (
    <EquityClassesPanel
      view={(props.view as ComponentProps<typeof EquityClassesPanel>["view"]) ?? null}
    />
  ),
  "equity-plans": (props) => (
    <EquityPlansPanel
      view={(props.view as ComponentProps<typeof EquityPlansPanel>["view"]) ?? null}
    />
  ),
  "equity-stakeholders": (props) => (
    <EquityStakeholdersPanel
      view={(props.view as ComponentProps<typeof EquityStakeholdersPanel>["view"]) ?? null}
    />
  ),
  "equity-new-drawer": (props) => (
    <NewRecordDrawer
      data={(props.data as ComponentProps<typeof NewRecordDrawer>["data"]) ?? null}
    />
  ),
  /** No remount key: the drawer resets through its close navigation. */
  "equity-security-drawer": (props) => {
    const drawer = props.drawer as ComponentProps<typeof SecurityDrawer> | null;
    if (!drawer) return null;
    return <SecurityDrawer {...drawer} />;
  },
} satisfies Record<string, WidgetRenderer>;
