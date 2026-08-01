import type { DocArticle } from '../types'

export const mcpControl: DocArticle = {
  slug: 'mcp-control',
  title: 'Model Context Protocol (MCP)',
  category: 'apps',
  order: 8,
  summary:
    'Connect an authorized AI or automation client to OpenBooks through the first-class MCP endpoint, with tenant, permission, workflow, and accounting controls preserved.',
  updated: '2026-07-31',
  keywords: [
    'MCP',
    'Model Context Protocol',
    'AI client',
    'Codex',
    'tools',
    'automation',
    'idempotency',
    'audit',
    'bearer token',
    'assistant',
    'confirmation',
  ],
  related: ['rest-api', 'roles-and-permissions', 'flows', 'audit-log', 'transaction-lifecycle'],
  body: `# Model Context Protocol (MCP)

OpenBooks exposes a first-class, Streamable HTTP Model Context Protocol endpoint
at **/mcp**. MCP clients can discover governed tools and tenant-specific record
metadata, read financial information, and perform authorized record operations
without controlling the browser.

MCP is an application interface, not a bypass around OpenBooks. Every call runs
as the user who owns the credential and preserves the same organization scope,
role permissions, subsidiary restrictions, feature controls, validation,
approval routing, period locks, accounting kernel, and audit evidence as the web
application.

## Before enabling a connection

Treat an MCP credential like an integration credential with authority to act.
An administrator should:

1. create or choose a dedicated OpenBooks user for the integration;
2. assign only the roles required for the intended workflows;
3. create a scoped key in **Settings → Extend → API Keys**;
4. set an expiry and a finite requests-per-minute limit;
5. store the one-time **ob_live_** value in the client's secret manager; and
6. test the connection against a masked sandbox before production use.

Do not issue an unscoped key to a broadly privileged administrator. A key's
effective permission is the intersection of its scopes and its owner's current
permissions. Removing a role or applying a user deny therefore reduces an
existing key's authority immediately.

## Connect a client

The production endpoint is the OpenBooks base URL followed by **/mcp**. Send the
key as a Bearer token in the **Authorization** header. The endpoint uses
stateless Streamable HTTP, so it works behind a horizontally scaled deployment
without session affinity.

Example Codex configuration:

~~~toml
[mcp_servers.openbooks]
url = "https://books.example.com/mcp"
bearer_token_env_var = "OPENBOOKS_MCP_TOKEN"
required = true
default_tools_approval_mode = "writes"
tool_timeout_sec = 120
~~~

Set **OPENBOOKS_MCP_TOKEN** in the environment that starts the client. Do not put
the plaintext token in a repository, shell history, client instructions, or an
AI prompt.

When browser-originated development clients are required, configure
**OPENBOOKS_MCP_ALLOWED_ORIGINS** as a comma-separated exact-origin allowlist.
When a deployment terminates requests on additional trusted host names,
configure **OPENBOOKS_MCP_ALLOWED_HOSTS**. OpenBooks rejects unexpected Host and
Origin values to reduce DNS-rebinding and cross-origin credential risk.

## Discovery and available surfaces

Tool discovery is permission-bound. A client sees only assistant tools its actor
may run. Record tools resolve permissions again after the requested record type
is known, so discovery never substitutes for execution-time authorization.

The core MCP surface includes:

- **list_record_types** — live built-in and published custom record schemas;
- **list_records** and **get_record** — tenant-, type-, and subsidiary-scoped reads;
- **create_record**, **update_record**, and **delete_record** — governed domain writes;
- **list_approvals** and **decide_approval** — actor-specific approval worklists
  and decisions with assignment, delegation, quorum, segregation-of-duties,
  comment, and signature controls;
- **submit_document**, **post_document**, **void_document**, and
  **correct_document** — explicit financial document lifecycle commands;
- **create_payment**, **update_payment**, and **post_payment** — governed vendor
  payment and customer receipt workflows with exact open-item allocations;
- **list_close_runs**, **get_close_run**, **start_close_run**, and the explicit
  refresh, approval, lock, publish, and controlled-reopen commands
  for the period-close lifecycle;
- financial searches and reports made available by the OpenBooks assistant
  registry, such as accounts, journals, documents, statements, aging, budgets,
  project profitability, and continuous-close findings; and
- the **openbooks://schema/record-types** resource for the current tenant's live
  record metadata.

Record schemas include custom fields and published custom record types. Clients
should call **list_record_types** instead of assuming that every organization
has the same fields.

## One capability catalog for MCP and Assistant

The in-app **Assistant** and the MCP endpoint are adapters over the same
application capability catalog. Names, descriptions, input schemas,
permission-bound discovery, validation, subsidiary enforcement, application
handlers, idempotency, workflow behavior, and structured results come from one
definition. Adding an accounting command to only one transport is not a
supported architecture.

The transports deliberately have different confirmation UX:

- an MCP host should review tool annotations and prompt for write or destructive
  calls before sending them; and
- the in-app Assistant never executes a mutating application tool during the
  model loop. It returns a signed, actor-bound, tenant-bound, input-bound review
  card that expires after ten minutes. Only the user's **Apply command** action
  invokes the shared application handler. Editing the input or token, changing
  users or organizations, or applying an expired card is rejected.

The Assistant records **assistant** as the operation source while MCP records
**mcp**. Both retain the human actor. This keeps audit provenance clear without
forking financial behavior.

## Safe writes and retries

Every MCP mutation requires an **idempotencyKey**. Generate a fresh opaque key
for each intended business action and retain it until the outcome is known. If a
timeout leaves the client uncertain, retry the exact same operation with the
same key. OpenBooks returns the original committed response and does not create a
second record. Reusing a key with different input is rejected as a conflict.

Idempotency evidence, the financial write, and the stored response commit in one
tenant-scoped database transaction. A failed operation rolls back completely and
may be retried safely.

Deletion is marked destructive for MCP clients, but OpenBooks still refuses to
delete retained financial evidence or referenced records. Use the applicable
void, reversal, correction, archive, or deactivate lifecycle rather than trying
to force a delete.

Document bodies may request **draft**, **submit**, or **post** actions. Submission
can create approval gates, and posting can return a pending-approval result. MCP
does not approve on the user's behalf, skip segregation of duties, override a
closed period, or suppress an accounting validation.

## Approvals and confirmations

Configure the MCP client to prompt for write tools. OpenBooks tool annotations
identify read-only and destructive operations, but client confirmation is an
additional control rather than the authorization boundary.

OpenBooks Flows remain authoritative. A signature-required approval accepts a
typed signature only when the actor explicitly supplied it, and the decision is
still checked for gate visibility, assignment or delegation, quorum, and
segregation of duties. It cannot be bulk-decided or silently satisfied by a
model. A model-generated proposal is never proof that the action was committed;
use the returned record status and audit evidence.

## Audit and monitoring

OpenBooks records both the MCP transport request and each tool execution in the
API key execution history. Tool events use paths such as
**/mcp/tools/create_record**, which lets an administrator separate discovery,
reads, writes, errors, and latency by credential. Financial mutations also carry
the actor and **mcp** source into transaction and workflow evidence.

Monitor for:

- repeated authorization failures;
- unexpected destructive-tool attempts;
- sustained rate-limit responses;
- new source IP addresses or user agents;
- unusual tool volume or latency; and
- idempotency conflicts, which usually indicate a client bug or key reuse.

## Credential incident response

If a token may be exposed:

1. revoke the key immediately in **Settings → Extend → API Keys**;
2. review its MCP tool events and the immutable financial audit log;
3. identify every record created or changed by the owning user and key window;
4. use controlled corrections or reversals for affected posted evidence;
5. rotate any secret store or deployment configuration that contained the key;
6. issue a narrower replacement key only after the root cause is resolved; and
7. preserve logs and investigation notes under the organization's incident and
   financial-control retention policy.

Revocation takes effect on the next request. The key row and its historical
execution events remain available for investigation.

## Production operating requirements

Terminate MCP traffic with TLS, keep OpenBooks private unless external access is
required, and enforce network policy appropriate to the organization. Production
deployments should also maintain database and object-storage backups, centralized
logs, alerting, time synchronization, key rotation, dependency patching, and a
tested restore procedure.

Use a masked sandbox for client upgrades and tool-contract changes. Validate at
least successful, invalid, unauthorized, duplicate-retry, concurrent-retry,
approval-gated, closed-period, and subsidiary-restricted cases before promoting
the client configuration to production.
`,
}
