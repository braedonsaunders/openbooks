import { getFeedbackSettings } from '../../../../lib/feedback/config'
import { PlatformFeedbackClient } from './PlatformFeedbackClient'

export const dynamic = 'force-dynamic'

/**
 * Where in-app issue reports go — an INSTALLATION setting, which is why it
 * lives in the operator console rather than in Company Settings: one
 * destination serves every organization on this deployment.
 *
 * The parent layout already gates the whole workspace on super-admin, and the
 * loader returns only the redacted view (never the stored token).
 */
export default async function PlatformFeedbackPage() {
  const settings = await getFeedbackSettings()
  return <PlatformFeedbackClient settings={settings} />
}
