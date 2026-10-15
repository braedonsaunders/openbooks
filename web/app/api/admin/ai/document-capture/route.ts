import { defineRoute } from "@/lib/api/route";

import { createDeleteDocumentCaptureHandler } from "./handlers"

const legacyDELETE = createDeleteDocumentCaptureHandler()

export const DELETE = defineRoute({
  permission: 'admin.ai.manage',
  feature: { none: 'Document capture credentials are governed by the admin AI permission.' },
  scope: 'unrestricted',
  handler: async () => legacyDELETE(),
});
