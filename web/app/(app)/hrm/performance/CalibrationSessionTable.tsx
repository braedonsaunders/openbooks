'use client'

import { PagedTable } from '../../../../components/paged-table'
import { CalibrationEntryEditor } from './continuous-islands'
import type { ContinuousData } from './continuous-view'

type Detail = NonNullable<NonNullable<ContinuousData['calibration']>['detail']>

/** A session uses the same registered list as the surrounding HR workspace. */
export function CalibrationSessionTable({ detail }: { detail: Detail }) {
  return (
    <PagedTable
      source="hrm_calibration_entries"
      rows={detail.entries}
      rowKey={(row) => row.id}
      searchable
      empty={detail.gridEmpty}
      columns={[
        {
          key: 'review',
          header: detail.gridCols.review,
          cell: (row) => row.review,
          search: (row) => row.review,
        },
        {
          key: 'proposed',
          header: detail.gridCols.proposed,
          cell: (row) => row.proposed,
        },
        {
          key: 'decision',
          header: detail.gridCols.decide,
          cell: (row) =>
            detail.status === 'closed' ? (
              <div className="space-y-1">
                <div>{row.editor.calibratedRating ?? row.proposed}</div>
                {row.editor.potentialKey ? (
                  <div>{row.editor.potentialLabel}: {row.editor.potentialKey}</div>
                ) : null}
                {row.editor.justification ? (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {row.editor.justificationLabel}: {row.editor.justification}
                  </p>
                ) : null}
              </div>
            ) : (
              <CalibrationEntryEditor {...row.editor} />
            ),
        },
      ]}
    />
  )
}
