import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/document-templates/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). Authoring stays HR (documents manage) in the service.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const saveTemplateBody = z.object({
  templateId: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  categoryKey: z.string().trim().min(1).max(80),
  bodyTemplate: z.string().min(1).max(100000),
  mergeFields: z.array(z.string().trim().min(1).max(80)).max(50),
  requiresSignature: z.boolean(),
  signerRoles: z.array(z.enum(["employee", "manager", "hr"])).max(3),
  acknowledgmentOnly: z.boolean(),
  isActive: z.boolean().optional(),
});
