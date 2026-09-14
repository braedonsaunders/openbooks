import type { DocArticle } from '../types'

export const extensions: DocArticle = {
  slug: 'app-authoring', title: 'Build and manage apps', category: 'apps', order: 0,
  summary: 'Create or import a package, edit its files and definitions, and activate a reviewed version.',
  updated: '2026-09-13', related: ['app-api-reference', 'record-customization', 'mcp-control'],
  keywords: ['modules', 'apps', 'agent', 'draft', 'native screens'],
  body: `# Build and manage apps

An app is one installed package of screens, record definitions, and optional backend actions. **Settings → Apps** is its management inventory. **Apps** is the launcher people use to open installed workspaces; it does not contain a second copy of the package.

## Describe, preview, activate

1. Choose **New app** and describe the work your team needs to do. The assistant can clarify the records, fields, users, and actions involved.
2. The agent prepares an unpublished draft. Open its review to see the package contents, requested access, and changes from the installed version.
3. Open **Preview**. Native record screens show the proposed shared form. Preview cannot query live records or run draft backend actions. Test stateful behavior in an organization sandbox before activation.
4. Request changes until the proposal is ready. Each revision is a new immutable draft.
5. Review the requested access and select **Activate app**. Activation creates or updates the package's owned definitions and switches the active version together. If the installed version changed during review, prepare a fresh draft.

Creation requires **apps.manage** and **admin.customization.manage**, with Apps enabled in **Company Settings → Features**. Activation also requires the permissions requested by the package. Drafts belong to the author and organization that created them. Disabling an app preserves its records and audit history.

## Edit and manage directly

Choose **New app** to start a native app, an HTML/CSS/JS app, or import a ZIP or JSON package. The description field can also send the request to an agent. Both paths produce the same reviewed package.

The package workspace includes configuration, native screens, record and field definitions, backend endpoints, permissions, settings, and navigation. The **Files** tab supports folders, uploads, source editing, rename, removal, and downloads. Save changes as a draft with a reason, review access, preview, and activate. Unsaved changes are guarded when closing the drawer.

Open an installed app to inspect its versions, execution runs, app storage, and audit history. Prepare a revision from an earlier version without overwriting history. Export packages, publish or withdraw your organization's library listing, disable an app, or uninstall through the same management drawer. Uninstall preserves governed business records and audit evidence.

## Where agents build

The in-app assistant and connected MCP agents use the same tools:

- **list_app_packages** lists installed packages and their active versions.
- **describe_app_vocabulary** supplies the supported package contract and a working example.
- **get_app_package** reads an installed version before upgrading it.
- **draft_app** validates and stores an unpublished package, returning review and preview links.
- **get_app_draft** reads the author's proposal and exact fingerprint.
- **activate_app_draft** activates that reviewed fingerprint after approval.

A package is a manifest plus files. Native screens use **frontend.renderer: native** with a JSON entry containing **screens**. A **records** screen names a published custom record type; its workspace uses the existing list, filters, forms, permissions, and audience controls. A **page** screen uses the shared page vocabulary with the restricted link-button widget. It cannot load arbitrary host widgets or uploaded JavaScript into the application origin.

An **action** screen uses the shared record-form fields and submits to a declared sandboxed backend endpoint. The server pins the installed version, validates the inputs, and checks both the user permissions and package grants. Backend record changes, package storage, and audit evidence commit together; a thrown failure rolls back the action. Lost-response retries replay the same submission. Preview never executes backend actions.

Owned **objects/*.json** definitions provision record types or custom fields through the existing platform services. These definitions use the existing custom-record storage and field system. Agents cannot create arbitrary SQL tables, run schema commands, or access database credentials. Backend logic uses the governed platform APIs. Existing foreign-owned definitions cannot be overwritten. Removing a definition from a later package does not delete existing data.

For custom interactive experiences, a package can use the existing sandboxed HTML frontend and governed backend endpoints. Native and sandboxed rendering are implementation choices within one app system. There is no separate drag-and-drop application builder. The app management workspace includes a file browser and editor, package import/export, configuration, definitions, versions, and execution logs. Build with an agent or edit the same package directly.

Page customizations, navigation entries, settings, and permission definitions belong to the same app package as its screens, records, fields, and backend actions. Every change goes through the same draft, preview, and activation flow. There is one installed version and one ownership record.
`,
}
