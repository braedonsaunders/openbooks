import type { ComponentProps } from 'react'
import { ClockControls } from '../field-time/ClockControls'
import { CrewWorkspace } from '../field-time/CrewWorkspace'
import { FieldTimeSetup } from '../field-time/FieldTimeSetup'
import { str, type WidgetRenderer } from './widget-props'

/**
 * HR-20 field-time widget family: the clock island, the foreman crew
 * workspace and the field-time setup surface (verbatim adapters only).
 * Split from widgets-hrm by responsibility — the composition test caps
 * a family file at 500 lines. Loader-resolved display data only, never
 * org or user ids; each island calls its own API routes.
 */
export const HRM_FIELD_TIME_WIDGETS = {
  /** The clock island: state card, primary action, picker sheet, offline queue. */
  'hrm-clock-controls': (props) => (
    <ClockControls
      initial={(props.initial as ComponentProps<typeof ClockControls>['initial'])!}
      projects={(props.projects as ComponentProps<typeof ClockControls>['projects']) ?? []}
      tasks={(props.tasks as ComponentProps<typeof ClockControls>['tasks']) ?? []}
      photoRequired={props.photoRequired === true}
      photoFolderId={str(props, 'photoFolderId') ?? null}
      geoHint={str(props, 'geoHint') ?? ''}
      clockOutLabel={str(props, 'clockOutLabel') ?? ''}
    />
  ),
  /** The foreman workspace: crew rows, sign-and-submit, stage actions. */
  'hrm-crew-workspace': (props) => (
    <CrewWorkspace
      batchId={str(props, 'batchId') ?? ''}
      status={str(props, 'status') ?? ''}
      locked={props.locked === true}
      initialLines={(props.initialLines as ComponentProps<typeof CrewWorkspace>['initialLines']) ?? []}
      workers={(props.workers as ComponentProps<typeof CrewWorkspace>['workers']) ?? []}
      timeTypes={(props.timeTypes as ComponentProps<typeof CrewWorkspace>['timeTypes']) ?? []}
      tasks={(props.tasks as ComponentProps<typeof CrewWorkspace>['tasks']) ?? []}
      equipment={(props.equipment as ComponentProps<typeof CrewWorkspace>['equipment']) ?? []}
      equipmentOn={props.equipmentOn === true}
      signatureRequired={props.signatureRequired !== false}
      signLabel={str(props, 'signLabel') ?? ''}
    />
  ),
  /** The field-time setup surface: rules, kiosks, chains. */
  'hrm-field-time-setup': (props) => (
    <FieldTimeSetup
      initialSettings={(props.initialSettings as ComponentProps<typeof FieldTimeSetup>['initialSettings'])!}
      kiosks={(props.kiosks as ComponentProps<typeof FieldTimeSetup>['kiosks']) ?? []}
      chains={(props.chains as ComponentProps<typeof FieldTimeSetup>['chains']) ?? []}
      kioskLinkBase={str(props, 'kioskLinkBase') ?? ''}
    />
  ),
} satisfies Record<string, WidgetRenderer>
