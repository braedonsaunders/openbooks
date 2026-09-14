import type { DocArticle } from '../types'

export const extensions: DocArticle = {
  slug: 'extensions', title: 'Build extensions with an agent', category: 'apps', order: 0,
  summary: 'Describe a workspace, preview an unpublished package, and activate the reviewed version.',
  updated: '2026-09-13', related: ['app-api-reference', 'record-customization', 'mcp-control'],
  keywords: ['modules', 'apps', 'agent', 'draft', 'native screens'],
  body: `# Build extensions with an agent

An extension is one installed package of screens, record definitions, and optional backend actions. **Settings → Extensions** is its management inventory. **Apps** is the launcher people use to open installed workspaces; it does not contain a second copy of the package. Older **/admin/apps** bookmarks open the same management inventory.

## Describe, preview, activate

1. Choose **New extension** and describe the work your team needs to do. The assistant can clarify the records, fields, users, and actions involved.
2. The agent prepares an unpublished draft. Open its review to see the package contents, requested access, and changes from the installed version.
3. Open **Preview**. Native record screens show the proposed shared form. Preview cannot query live records or run draft backend actions. Test stateful behavior in an organization sandbox before activation.
4. Request changes until the proposal is ready. Each revision is a new immutable draft.
5. Review the requested access and select **Activate extension**. Activation creates or updates the package's owned definitions and switches the active version together. If the installed version changed during review, prepare a fresh draft.

Creation requires **apps.manage** and **admin.customization.manage**, with Apps enabled in **Company Settings → Features**. Activation also requires the permissions requested by the package. Drafts belong to the author and organization that created them. Disabling an extension preserves its records and audit history.

## Where agents build

The in-app assistant and connected MCP agents use the same tools:

- **describe_extension_vocabulary** supplies the supported package contract and a working example.
- **get_extension_package** reads an installed version before upgrading it.
- **draft_extension** validates and stores an unpublished package, returning review and preview links.
- **get_extension_draft** reads the author's proposal and exact fingerprint.
- **activate_extension_draft** activates that reviewed fingerprint after approval.

A package is a manifest plus files. Native screens use **frontend.renderer: native** with a JSON entry containing **screens**. A **records** screen names a published custom record type; its workspace uses the existing list, filters, forms, permissions, and audience controls. A **page** screen uses the shared page vocabulary with the restricted link-button widget. It cannot load arbitrary host widgets or uploaded JavaScript into the application origin.

Owned **objects/*.json** definitions provision record types or custom fields through the existing platform services. Existing foreign-owned definitions cannot be overwritten. Removing a definition from a later package does not delete existing data.

For custom interactive experiences, a package can use the existing sandboxed HTML frontend and governed backend endpoints. Native and sandboxed rendering are implementation choices within one extension system. There is no separate drag-and-drop application builder. Package source is available as an advanced detail; ordinary creation starts with a business requirement.

Legacy page-customization modules retain their existing approval and rollback controls. Their advanced manifests change supported existing routes; new extension workspaces use the package workflow above.
`,
}
