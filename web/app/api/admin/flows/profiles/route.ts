import { defineRoute } from "@/lib/api/route";
import { NextResponse } from 'next/server'
import { DOCUMENT_FLOW_KINDS, listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
import { PAY_RUN_SUBJECT_KIND } from '@openbooks/engine/src/flows/pay-runs-adapter.ts'
import { flowSubjectGroup } from './groups.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

/**
 * Flow subject profiles — the builder vocabulary (triggers, actions,
 * statuses, fields, roles) per subject kind. Drives the New Flow picker and
 * every inspector select in the builder. The picker groups record types by
 * product area (`group`, see ./groups.ts), so same-named kinds from
 * different families stay distinguishable.
 */
async function legacyGET() {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  return NextResponse.json({
    profiles: listFlowSubjectProfiles().map((profile) => {
      // Pay runs ride the generic document kind list but carry payroll's
      // dedicated profile, so they group with payroll, not documents.
      const group =
        DOCUMENT_FLOW_KINDS.includes(profile.subjectKind) &&
        profile.subjectKind !== PAY_RUN_SUBJECT_KIND
          ? 'documents'
          : flowSubjectGroup(profile.subjectKind)
      if (!profile.labelKey) return { ...profile, group }
      const { label: _label, ...stableProfile } = profile
      return { ...stableProfile, group }
    }),
  })
}

export const GET = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  handler: async () => legacyGET(),
});
