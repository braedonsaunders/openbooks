'use client'
import type { FormSection } from '@openbooks/forms-core'
import { RecordFields } from '@/components/record-fields'

/** No submit, upload or lookup mutation is possible from a package preview. */
export function DraftRecordPreview({ sections }: { sections: FormSection[] }) {
  return <RecordFields sections={sections} values={{}} disabled onChange={() => {}} />
}
