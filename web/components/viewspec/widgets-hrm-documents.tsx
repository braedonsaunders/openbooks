import type { ComponentProps } from 'react'

import { DocumentsDrawer, DocumentsGenerateDialog } from '../../app/(app)/hrm/documents/sections'
import { SurveysAuthorDialog, SurveysDrawer } from '../../app/(app)/hrm/surveys/sections'
import { OrgChartPerson, OrgChartTree } from '../../app/(app)/hrm/org-chart/sections'
import { MeDocumentActions, MeExportDialog, MeExportDownload } from '../../app/(app)/me/documents/sections'
import { MeSurveyRespond } from '../../app/(app)/me/surveys/sections'

import { str, type WidgetRenderer } from './widget-props'

/** HR-19 document widgets, split out of widgets-hrm.tsx to keep each
 *  family under the 500-line composition cap. Verbatim adapters only. */
export const HRM_DOCUMENT_WIDGETS = {
  // HR-19 begin: the document flyout (signers timeline, events, versions,
  // send/remind/void/hold) and the generate dialog (template + person +
  // merge preview), both closing by navigation. Null payloads render
  // nothing — the spec's `when` gates already omit them.
  'hrm-documents-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof DocumentsDrawer>['drawer']
    if (!drawer) return null
    return <DocumentsDrawer drawer={drawer} />
  },
  'hrm-documents-generate-dialog': (props) => {
    const generate = props.generate as ComponentProps<typeof DocumentsGenerateDialog>['generate']
    if (!generate) return null
    return <DocumentsGenerateDialog generate={generate} />
  },
  /** The survey flyout: the aggregate results panel (eNPS, drivers, the
   *  suppression-marked heatmap, comments, trend) with open/close
   *  actions, closing by navigation. */
  'hrm-surveys-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof SurveysDrawer>['drawer']
    if (!drawer) return null
    return <SurveysDrawer drawer={drawer} />
  },
  /** The survey author dialog, opened from the page header through the
   *  `author` search param; closing navigates the param away. */
  'hrm-surveys-author-dialog': (props) => {
    const author = props.author as ComponentProps<typeof SurveysAuthorDialog>['author']
    if (!author) return null
    return <SurveysAuthorDialog author={author} />
  },
  /** The org-chart tree: collapsible nodes, vacancy dashes, as-of
   *  search, and the narrow-screen card stack. Loader-resolved props
   *  only — no org or user crosses into the widget. */
  'org-chart-tree': (props) => (
    <OrgChartTree
      chart={props.chart as ComponentProps<typeof OrgChartTree>['chart']}
      personBaseHref={str(props, 'personBaseHref') ?? '/hrm/org-chart'}
      labels={(props.labels as ComponentProps<typeof OrgChartTree>['labels']) ?? {}}
    />
  ),
  /** The org-chart person drawer, closing by navigation. */
  'hrm-org-chart-person': (props) => {
    const selected = props.selected as ComponentProps<typeof OrgChartPerson>['selected']
    if (!selected) return null
    return (
      <OrgChartPerson
        selected={selected}
        closeHref={str(props, 'closeHref') ?? '/hrm/org-chart'}
        labels={(props.labels as ComponentProps<typeof OrgChartPerson>['labels']) ?? {}}
      />
    )
  },
  /** Me document row actions: inline sign (typed name) and acknowledge.
   *  Renders nothing when the row carries neither action. */
  'hrm-me-document-actions': (props) => (
    <MeDocumentActions
      documentId={str(props, 'documentId') ?? ''}
      signable={props.signable === true}
      acknowledgeable={props.acknowledgeable === true}
      signLabel={str(props, 'signLabel') ?? ''}
      signNameLabel={str(props, 'signNameLabel') ?? ''}
      acknowledgeLabel={str(props, 'acknowledgeLabel') ?? ''}
      actionFailed={str(props, 'actionFailed') ?? ''}
    />
  ),
  /** Me export download cell: the link only while downloadable. */
  'hrm-me-export-download': (props) => (
    <MeExportDownload
      downloadable={props.downloadable === true}
      href={str(props, 'href') ?? ''}
      label={str(props, 'label') ?? ''}
    />
  ),
  /** Me export-my-data dialog, opened through `?export=1`. */
  'hrm-me-export-dialog': (props) => (
    <MeExportDialog
      partyId={str(props, 'partyId') ?? ''}
      requestExportLabel={str(props, 'requestExportLabel') ?? ''}
      requestExportDone={str(props, 'requestExportDone') ?? ''}
      actionFailed={str(props, 'actionFailed') ?? ''}
    />
  ),
  /** Me open-surveys respond cell: reissues the token and navigates. */
  'hrm-me-survey-respond': (props) => (
    <MeSurveyRespond
      invitationId={str(props, 'invitationId') ?? ''}
      respondLabel={str(props, 'respondLabel') ?? ''}
      actionFailed={str(props, 'actionFailed') ?? ''}
    />
  ),
  // HR-19 end
} satisfies Record<string, WidgetRenderer>
