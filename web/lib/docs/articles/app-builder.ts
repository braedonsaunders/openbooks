import type { DocArticle } from '../types'

export const appBuilder: DocArticle = {
  slug: 'app-builder',
  title: 'App Builder',
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
  body: `# App Builder

**Settings → Extend → App Builder** (route **/admin/apps**) is where an
administrator authors, packages, secures, and publishes apps. It requires the
**Install and manage apps** permission, which is separate from the everyday
**Use apps** permission that lets people open installed apps.

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

## Create or import an app

From the App Builder toolbar:

- **New app** creates a starter app containing a frontend entry, a stylesheet,
  and one backend endpoint for immediate editing.
- **Import .zip** installs a package from a zip archive. The **manifest.json**
  must be at the archive root. A single enclosing directory is removed during
  import. Operating-system metadata such as **__MACOSX** and **.DS_Store** is
  ignored. Archives are bounded by file count and size so an import cannot
  exhaust resources.

## Edit files

The **Files** tab is a file tree with a code editor (JavaScript, HTML, CSS, and
JSON syntax). Create, upload, edit, and delete files, and save with Cmd/Ctrl-S.
Two files are structural and protected: **manifest.json** is edited through the
Overview form rather than as raw text, and the frontend entry and endpoint files
cannot be deleted while the manifest references them.

## Configure capabilities and endpoints

The **Overview** tab manages manifest settings through a form rather than direct
JSON editing. It sets the name,
description, navigation visibility, the **Backend endpoints** list, and the
app's **Capabilities**. Capabilities cover the self-describing platform record
API: ledger, payables, receivables, parties, items, projects, assets, and custom
records each expose their relevant read and write permission. **Create & post
journals** adds the dedicated balanced-journal writer.

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

The **Runs** tab is the backend execution log. Every endpoint call records its
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

## App Builder versus Scripts

The **Scripts** area (**Settings → Extend → Scripts**) and the App Builder share
the same sandbox engine and the same governed ledger-write path, but they support
different extension models. Scripts are trigger-driven automation. They run on document
lifecycle events (submit, post, void), on a schedule, or as standalone endpoints,
and ship no user interface. Apps are packaged extensions with a frontend, backend
endpoints, provisioned objects, and a distribution channel. Use a script to
automate rules on existing records. Use an app to deliver a packaged feature.
`,
}
