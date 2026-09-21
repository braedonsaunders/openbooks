import type { ComponentProps } from 'react'
import {
  CalibrationDistributionShell,
  CalibrationEntryShell,
  CalibrationMissingShell,
  FeedbackDialogShell,
  FeedbackSettingsShell,
  NoteShell,
  OneOnOneDrawer,
  SessionActionsShell,
  SessionDialogShell,
  TalentDialogShell,
} from '../../app/(app)/hrm/performance/continuous-sections'
import { str, type WidgetRenderer } from './widget-props'

/**
 * HR-17 continuous-performance widget family: 1:1s, feedback,
 * calibration, talent review and succession (verbatim adapters only).
 * Split from widgets-hrm by responsibility — the composition test caps
 * a family file at 500 lines.
 */
export const HRM_CONTINUOUS_WIDGETS = {
  /** One calibration grid row: the inline rating/potential/justification editor. */
  'hrm-calibration-entry': (props) => {
    const editor = props.editor as ComponentProps<typeof CalibrationEntryShell>['editor']
    if (!editor) return null
    return <CalibrationEntryShell editor={editor} />
  },
  /** Session open/close actions beside the grid. */
  'hrm-session-actions': (props) => (
    <SessionActionsShell
      detail={{
        id: str(props, 'sessionId') ?? '',
        status: str(props, 'status') ?? '',
        openLabel: str(props, 'openLabel') ?? '',
        closeLabel: str(props, 'closeLabel') ?? '',
        failed: str(props, 'failed') ?? '',
      } as ComponentProps<typeof SessionActionsShell>['detail']}
    />
  ),
  /** The session create dialog, opened from ?session=new. */
  'hrm-session-dialog': (props) => {
    const create = props.create as ComponentProps<typeof SessionDialogShell>['create']
    if (!create) return null
    return <SessionDialogShell create={create} />
  },
  /** The distribution strip above the grid: counts per calibrated rating. */
  'hrm-calibration-distribution': (props) => (
    <CalibrationDistributionShell
      title={str(props, 'title') ?? ''}
      distribution={(props.distribution as { key: string; count: number; width: number }[]) ?? []}
    />
  ),
  /** Reviews that did not enter the session, each with its reason. */
  'hrm-calibration-missing': (props) => (
    <CalibrationMissingShell
      title={str(props, 'title') ?? ''}
      missing={(props.missing as { review: string; reason: string }[]) ?? []}
    />
  ),
  /** The talent and succession record dialog (HR). */
  'hrm-talent-dialog': (props) => {
    const dialog = props.dialog as ComponentProps<typeof TalentDialogShell>['dialog']
    if (!dialog) return null
    return <TalentDialogShell dialog={dialog} />
  },
  /** HR-owned feedback settings: who may praise publicly. */
  'hrm-feedback-settings': (props) => {
    const settings = props.settings as ComponentProps<typeof FeedbackSettingsShell>['settings']
    if (!settings) return null
    return <FeedbackSettingsShell settings={settings} />
  },
  /** Give praise / request feedback / fulfil a request, from Me and Team. */
  'hrm-feedback-dialog': (props) => (
    <FeedbackDialogShell
      subjectEmploymentId={str(props, 'subjectEmploymentId') ?? ''}
      requestedFromPartyId={str(props, 'requestedFromPartyId') ?? null}
      subjectLabel={str(props, 'subjectLabel') ?? ''}
      requestId={str(props, 'requestId') ?? null}
      kinds={(props.kinds as { value: string; label: string }[]) ?? []}
      kindLabel={str(props, 'kindLabel') ?? ''}
      visibilities={(props.visibilities as { value: string; label: string }[]) ?? []}
      visibilityLabel={str(props, 'visibilityLabel') ?? ''}
      bodyLabel={str(props, 'bodyLabel') ?? ''}
      bodyPlaceholder={str(props, 'bodyPlaceholder') ?? ''}
      submitLabel={str(props, 'submitLabel') ?? ''}
      cancelLabel={str(props, 'cancelLabel') ?? ''}
      closeHref={str(props, 'closeHref') ?? ''}
      failed={str(props, 'failed') ?? ''}
      openLabel={str(props, 'openLabel') ?? ''}
    />
  ),
  /** The 1:1 agenda flyout over the loader-resolved meeting. */
  'hrm-one-on-one-drawer': (props) => {
    const detail = props.detail as ComponentProps<typeof OneOnOneDrawer>['detail']
    if (!detail) return null
    return <OneOnOneDrawer detail={detail} />
  },
  /** A small loader-resolved note line (9-box unplaced placements). */
  'hrm-note': (props) => <NoteShell note={str(props, 'note') ?? null} />,
  // HR-17 end
} satisfies Record<string, WidgetRenderer>
