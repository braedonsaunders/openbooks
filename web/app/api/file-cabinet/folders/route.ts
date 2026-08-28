import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { getFolder, getFolderTree, createFolder } from '../../../../lib/file-cabinet'
import { isUuid } from '../../../../lib/list-params'
import { can, guardPermission } from '../../../../lib/authz'
import { fileViewer, requireFolderAccess, requireSession } from '../lib'

export const runtime = 'nodejs'

/** Folder tree for the org (flat list with parent references + counts). */
export async function GET() {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const tree = await getFolderTree(gate.user.orgId, fileViewer(gate))
  return NextResponse.json({ folders: tree })
}

/** Create a folder. */
export async function POST(req: Request) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  // Parent (when provided) must be a valid folder inside the caller's org.
  const parentId = typeof body.parentId === 'string' ? body.parentId : null
  if (parentId !== null) {
    if (!isUuid(parentId) || !(await getFolder(gate.user.orgId, parentId))) {
      return NextResponse.json({ error: 'parent folder not found' }, { status: 400 })
    }
    // Creating a sub-folder needs Editor+ on the parent.
    const access = await requireFolderAccess(gate, parentId, 'editor')
    if (access) return access
  } else if (!can(gate, 'documents.manage') && !can(gate, '*')) {
    // Creating a top-level folder needs the org-wide manage permission.
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const id = await createFolder({
    orgId: gate.user.orgId,
    parentId,
    name: body.name.trim(),
    isPrivate: body.isPrivate === true,
    ownerId: body.isPrivate === true ? gate.user.id : undefined,
    createdBy: gate.user.id,
    audit: { actorId: gate.user.id },
  })
  return NextResponse.json({ id }, { status: 201 })
}
