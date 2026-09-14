import type { DocArticle } from '../types'

export const appBuilder: DocArticle = {
  slug: 'app-builder',
  title: 'Advanced sandbox package reference',
  category: 'apps',
  order: 2,
  summary:
    'Create, edit, provision, secure, run, and publish organization apps — a sandboxed frontend plus a governed backend.',
  updated: '2026-07-31',
  keywords: [
    'app builder',
    'app package',
    'manifest',
    'endpoints',
    'capabilities',
    'provisioning',
    'objects',
    'publish',
    'marketplace',
    'App Library',
    'sandbox',
  ],
  related: ['apps', 'app-api-reference', 'scripting-engine', 'scripting-api-reference', 'record-customization'],
  body: `# Advanced sandbox package reference

For the current creation and review flow, see [App authoring guide](/docs/app-authoring).

**Settings → Apps** is the package inventory. An agent prepares a complete
package revision for review and activation; **Apps** launches its active workspace.
Sandbox and native frontends use the same package, permission, and version model.

An app bundles a **sandboxed frontend** (HTML, JS, and CSS that render in an
isolated iframe) with a **governed backend** (server-side endpoint scripts that
run in the same sandbox the scripting engine uses). Together, these components
support custom screens backed by permission-checked server actions.

## The app package

An app is a package of a **manifest** plus its **files**. The manifest declares:

- **key** — a stable slug that identifies the app in your organization.
- **name**, **version**, **description**, and an optional sidebar **icon**.
- **permissions** — the capabilities the app requests (see below).
- **frontend.entry** — the HTML file that renders when the app opens.
- **endpoints** — named backend handlers, each pointing at a file and an HTTP
  method (**GET**, **POST**, or **ANY**). Endpoint names must be unique.
- **nav** — optional label and icon suggestions for an administrator-created
  navigation shortcut.

Installing an app never places it in a workspace automatically. An
administrator can add, move, rename, or remove an app shortcut in Navigation
settings without installing, disabling, or uninstalling the app. Every active
app remains available from the Apps library. Placement on host surfaces does
not alter the app's sandbox or permission boundary.

A typical bundle looks like:

~~~text
manifest.json
frontend/index.html        (the entry)
frontend/styles.css
backend/hello.js           (an endpoint handler)
objects/customer-note.json (a provisioning spec)
~~~

Files are classified automatically: the entry and anything under **frontend/**
is frontend, endpoint files are backend, and everything else is an asset.

## Create and revise a package

Choose **New app** in Settings → Apps and describe the business
requirement. The agent uses the app vocabulary and draft tools to prepare
screens, backend endpoints, records, fields, and optional page, navigation,
setting, and permission contributions together. Review the draft and requested
authority before activating it. For changes, request a new complete revision;
activated manifests and files are immutable.

## Capabilities

The manifest requests platform capabilities. These cover the self-describing
record API, including journals, payables, receivables, parties, items, projects,
assets, and custom records. Posting uses the existing balanced-journal writer.

Capabilities not listed in the grant are denied by default. Grant only the
permissions required by the app. Every backend and bridge call is checked
against these grants **intersected with the
calling user's own permissions**. The resulting authority cannot exceed the
calling user's authority. The App API filters its live schema and operations to
that intersection. The app's private key-value store is available without a
capability grant.

## Provision records and fields

A bundle file under **objects/** declares a platform object created when the app
installs. Two kinds are supported:

- **record_type** — a custom record type (key, name, icon, fields). When it is
  set to show in navigation, it becomes its own nav entry.
- **custom_field** — a field added to a core table such as documents, document
  lines, parties, projects, accounts, or items.

Provisioning runs inside the install transaction. An app may create new objects
and update objects it provisioned before, but a name collision with a
user-authored object or another app's object causes installation to fail.
Provisioned record types and fields hold live business data, so **uninstalling an app keeps
them**. Removing the app does not delete existing records.

## Run history

The **Run history** section is the backend execution log. Every endpoint call records its
status (ok, error, timeout, or forbidden), timestamp, endpoint name, the
**governance units** it consumed, its duration, any error message, and the log
lines it emitted. Use it to investigate a failing action.

## Sandbox and isolation

- The **frontend** runs in an opaque-origin sandboxed iframe with no cookies, no
  access to the parent page, and a content-security policy that blocks it from
  making its own network calls. Its only channel to the platform is a validated
  message bridge exposing **openbooks.getContext()**, **openbooks.callBackend()**,
  custom-record helpers, and self-describing governed platform record CRUD.
- The **backend** runs in a WebAssembly JavaScript sandbox with no filesystem,
  no network, and no database connection. It reaches data only through the
  permission-scoped adapters the platform injects, under a memory limit, a time
  limit, and a per-run unit budget.

See **App API Reference** for the exact frontend and backend function contract,
including parameters, return values, permissions, errors, governance costs,
and limits. The **Scripting Engine** and **Scripting API Reference** describe
the related trigger-script surface, which is not interchangeable with the App
API.

## Publish to the App Library

The version model is **draft → active → superseded**. Installing or updating an
app inserts a new immutable version and supersedes the previous one; a duplicate
version string is rejected rather than overwriting history.

**Publish to marketplace** snapshots the active bundle into the **App Library**,
where other organizations can install it. There is one listing per app key
across the deployment, and only the original publisher can update it. Installing
from the library runs the same validation, capability-grant, and provisioning
path as any other installation. The installed copy has no access to the
publisher's live data.

## Apps and scripts

The **Scripts** area (**Settings → Extend → Scripts**) and apps share
the same sandbox engine and the same governed ledger-write path, but they support
different app models. Scripts are trigger-driven automation. They run on document
lifecycle events (submit, post, void), on a schedule, or as standalone endpoints,
and ship no user interface. Apps are packaged apps with a frontend, backend
endpoints, provisioned objects, and a distribution channel. Use a script to
automate rules on existing records. Use an app to deliver a packaged feature.
`,
}
