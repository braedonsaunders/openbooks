import { defineRoute } from "@/lib/api/route";

import { createDeleteDocumentCaptureHandler } from "./handlers";

const legacyDELETE = createDeleteDocumentCaptureHandler();

export const DELETE = defineRoute({
  permission: "admin.ai.manage",
  feature: {
    none: "Administrators can manage document capture credentials before document capture is enabled.",
  },
  scope: "unrestricted",
  handler: async () => legacyDELETE(),
});
