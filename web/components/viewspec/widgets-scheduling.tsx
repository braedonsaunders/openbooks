import type { ComponentProps } from "react";
import {
  MySchedule,
  SchedulingWorkspace,
  ServiceHome,
  ServiceMyVisits,
  ServiceNewButton,
  ServiceRecordHost,
} from "./native-widgets.client";
import { type WidgetRenderer } from "./widget-props";

/** The unified scheduling workspace (people, task and dispatch boards) and the service area it dispatches. */
export const SCHEDULING_WIDGETS = {
  "scheduling-workspace": (props) => {
    const workspace = props as unknown as ComponentProps<typeof SchedulingWorkspace>;
    return <SchedulingWorkspace {...workspace} />;
  },
  "scheduling-my-schedule": (props) => (
    <MySchedule
      entries={props.entries as ComponentProps<typeof MySchedule>["entries"]}
      from={props.from as ComponentProps<typeof MySchedule>["from"]}
      through={props.through as ComponentProps<typeof MySchedule>["through"]}
      today={props.today as ComponentProps<typeof MySchedule>["today"]}
      refusal={props.refusal as ComponentProps<typeof MySchedule>["refusal"]}
      requestableEntryIds={
        props.requestableEntryIds as ComponentProps<typeof MySchedule>["requestableEntryIds"]
      }
      personPartyId={props.personPartyId as ComponentProps<typeof MySchedule>["personPartyId"]}
    />
  ),
  "service-home": (props) => {
    const home = props as unknown as ComponentProps<typeof ServiceHome>;
    return <ServiceHome summary={home.summary} canConfigure={home.canConfigure} />;
  },
  "service-my-visits": (props) => (
    <ServiceMyVisits
      today={props.today as ComponentProps<typeof ServiceMyVisits>["today"]}
      initial={props.initial as ComponentProps<typeof ServiceMyVisits>["initial"]}
      refusal={props.refusal as ComponentProps<typeof ServiceMyVisits>["refusal"]}
    />
  ),
  "service-new-button": (props) => (
    <ServiceNewButton
      kind={String(props.kind ?? "")}
      label={String(props.label ?? "")}
      basePath={typeof props.basePath === "string" ? props.basePath : undefined}
    />
  ),
  // The record host loads the record the address names; it takes no props.
  "service-record-host": () => <ServiceRecordHost />,
} satisfies Record<string, WidgetRenderer>;
