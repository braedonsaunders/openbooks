'use server'

import { revalidatePath } from 'next/cache'
import { verifyGithubIssueAccess } from '@braedonsaunders/appkit-feedback'
import { requireSuperAdmin } from '../../../../lib/super-admin'
import { recordFeedbackSettingsAudit } from '../../../../lib/feedback/audit'
import {
  clearFeedbackToken,
  getFeedbackSettings,
  getFeedbackToken,
  parseFeedbackLabels,
  saveFeedbackSettings,
  type FeedbackSettingsInput,
  type FeedbackSettingsView,
} from '../../../../lib/feedback/config'
import { feedbackGithubRequest } from '../../../../lib/feedback/github'

/**
 * Operator writes for the in-app issue destination.
 *
 * Every action re-derives the super-admin gate from the session — a server
 * action is a public endpoint, and the page's gate is not the action's gate.
 * Enabling a destination VERIFIES it against the tracker before it is stored,
 * so the first time a credential is wrong is here, in front of the operator,
 * not later in front of someone reporting a defect.
 */

export type FeedbackSettingsResult =
  | { ok: true; settings: FeedbackSettingsView }
  | { ok: false; message: string }

function reason(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The issue reporting settings could not be saved.'
}

export async function saveFeedbackSettingsAction(
  input: FeedbackSettingsInput,
): Promise<FeedbackSettingsResult> {
  const authz = await requireSuperAdmin()
  const before = await getFeedbackSettings()
  try {
    if (input.enabled) {
      const token = input.token?.trim() || (await getFeedbackToken())
      if (!token) throw new Error('An access token is required before reporting can be enabled.')
      await verifyGithubIssueAccess({
        owner: input.owner.trim(),
        repo: input.repo.trim(),
        token,
        labels: parseFeedbackLabels(input.labels),
        request: feedbackGithubRequest,
      })
    }
    const after = await saveFeedbackSettings(input, authz.user.id)
    await recordFeedbackSettingsAudit({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      before,
      after,
      reason: input.token
        ? 'Updated in-app issue reporting and rotated the access token'
        : 'Updated in-app issue reporting',
    })
    revalidatePath('/platform/feedback')
    revalidatePath('/platform')
    return { ok: true, settings: after }
  } catch (error) {
    return { ok: false, message: reason(error) }
  }
}

export async function clearFeedbackTokenAction(): Promise<FeedbackSettingsResult> {
  const authz = await requireSuperAdmin()
  const before = await getFeedbackSettings()
  try {
    await clearFeedbackToken(authz.user.id)
    const after = await getFeedbackSettings()
    await recordFeedbackSettingsAudit({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      before,
      after,
      reason: 'Removed the in-app issue reporting access token',
    })
    revalidatePath('/platform/feedback')
    revalidatePath('/platform')
    return { ok: true, settings: after }
  } catch (error) {
    return { ok: false, message: reason(error) }
  }
}
