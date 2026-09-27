import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  getFolder,
  getFolderTree,
  createFolder,
} from "../../../../lib/file-cabinet";
import { isUuid } from "../../../../lib/list-params";
import { can } from "../../../../lib/authz";
import { fileViewer, requireFolderAccess } from "../lib";
const postBodySchema0 = z.strictObject({
  name: z.string().trim().min(1, "name is required").max(255),
  parentId: z.string().uuid("parentId must be a valid id").nullable().optional(),
  isPrivate: z.boolean().optional(),
});

export { runtime } from "@/lib/api/route";

/** Folder tree for the org (flat list with parent references + counts). */
export const GET = defineRoute({
  permission: "documents.read",
  feature: {
    none: "This documents surface is governed by its permission and has no separate organization feature switch.",
  },
  handler: async ({ authz: gate }) => {
    const tree = await getFolderTree(gate.user.orgId, fileViewer(gate));
    return NextResponse.json({ folders: tree });
  },
});

/** Create a folder. */
export const POST = defineRoute({
  public: "session",
  body: postBodySchema0,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    const body = routeBody;
    // Parent (when provided) must be a valid folder inside the caller's org.
    const parentId = body.parentId ?? null;
    if (parentId !== null) {
      if (!isUuid(parentId) || !(await getFolder(gate.user.orgId, parentId))) {
        return NextResponse.json(
          { error: "parent folder not found" },
          { status: 400 },
        );
      }
      // Creating a sub-folder needs Editor+ on the parent.
      const access = await requireFolderAccess(gate, parentId, "editor");
      if (access) return access;
    } else if (!can(gate, "documents.manage") && !can(gate, "*")) {
      // Creating a top-level folder needs the org-wide manage permission.
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const id = await createFolder({
      orgId: gate.user.orgId,
      parentId,
      name: body.name,
      isPrivate: body.isPrivate === true,
      ownerId: body.isPrivate === true ? gate.user.id : undefined,
      createdBy: gate.user.id,
      audit: { actorId: gate.user.id, viewer: fileViewer(gate) },
    });
    return NextResponse.json({ id }, { status: 201 });
  },
});
