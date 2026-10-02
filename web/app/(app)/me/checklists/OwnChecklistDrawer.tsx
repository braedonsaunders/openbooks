'use client'
import type { OwnStep } from '@openbooks/engine/hrm/processes'
import { DirtyUrlDrawer } from '../../../../components/dirty-url-drawer'
import { ProcessChecklistBody } from '../../hrm/processes-client'
/** Self service renders the same step form, with no checklist-wide authority or peer evidence. */
export function OwnChecklistDrawer({ step }: { step: OwnStep }) {
  return (
    <DirtyUrlDrawer open closeHref="/me/checklists" title={step.title} size="2xl">
      <ProcessChecklistBody
        detail={{
          id: step.processId,
          kind: '',
          effectiveDate: '',
          status: step.processStatus,
          employmentId: '',
          workerPartyId: '',
          workerName: '',
          openedByChangeId: null,
          canManage: false,
          progress: {
            total: 1,
            required: Number(step.required),
            doneRequired: Number(step.required && step.status !== 'pending'),
            allRequiredDone: step.status !== 'pending',
          },
          steps: [
            {
              ...step,
              position: 0,
              ownerKind: 'employee',
              ownerPartyId: null,
              doneBy: null,
              skipReason: null,
              canComplete: true,
              canSkip: false,
            },
          ],
        }}
      />
    </DirtyUrlDrawer>
  )
}
