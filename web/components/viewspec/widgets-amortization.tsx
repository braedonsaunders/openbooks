import type { ComponentProps } from "react";
import {
  AmortizationNewScheduleButton,
  AmortizationReconciliationPanel,
  AmortizationRunPanel,
  AmortizationSchedulesPanel,
} from "../../app/(app)/accounting/amortization/AmortizationWorkspace";
import { ScheduleDrawer } from "../../app/(app)/accounting/amortization/ScheduleDrawer";
import { str, type WidgetRenderer } from "./widget-props";

/** Expense amortization adapters: compose the native workspace components without changing their props. */
export const AMORTIZATION_WIDGETS = {
  "amortization-schedules": (props) => (
    <AmortizationSchedulesPanel
      rows={(props.rows as ComponentProps<typeof AmortizationSchedulesPanel>["rows"]) ?? []}
      statusTabs={
        (props.statusTabs as ComponentProps<typeof AmortizationSchedulesPanel>["statusTabs"]) ?? []
      }
      templatesHref={str(props, "templatesHref") ?? "/admin/setup/expense-amortization-templates"}
      waterfallHref={str(props, "waterfallHref") ?? null}
    />
  ),
  "amortization-run": (props) => (
    <AmortizationRunPanel
      periods={(props.periods as ComponentProps<typeof AmortizationRunPanel>["periods"]) ?? []}
      selectedPeriodId={str(props, "selectedPeriodId") ?? null}
      due={(props.due as ComponentProps<typeof AmortizationRunPanel>["due"]) ?? []}
      canManage={props.canManage === true}
    />
  ),
  "amortization-reconciliation": (props) => (
    <AmortizationReconciliationPanel
      asOf={str(props, "asOf") ?? ""}
      rows={(props.rows as ComponentProps<typeof AmortizationReconciliationPanel>["rows"]) ?? []}
      reportHref={str(props, "reportHref") ?? null}
    />
  ),
  "amortization-new-schedule": (props) => (
    <AmortizationNewScheduleButton
      data={(props.data as ComponentProps<typeof AmortizationNewScheduleButton>["data"]) ?? null}
      templatesHref={str(props, "templatesHref") ?? "/admin/setup/expense-amortization-templates"}
    />
  ),
  "amortization-schedule-drawer": (props) => {
    const drawer = props.drawer as ComponentProps<typeof ScheduleDrawer> | null;
    if (!drawer) return null;
    return <ScheduleDrawer key={drawer.detail.schedule.id} {...drawer} />;
  },
} satisfies Record<string, WidgetRenderer>;
