# Security policy

OpenBooks handles financial and identity data. Please report suspected
vulnerabilities privately and give the maintainers a reasonable opportunity to
investigate before public disclosure.

## Supported versions

OpenBooks is currently in alpha. Security fixes are made on the latest published
release and the `main` branch.

| Version | Supported |
| --- | --- |
| Latest `0.1.x` alpha release | Yes |
| Older builds and untagged snapshots | No |

Alpha status matters: OpenBooks has not yet completed an independent security
audit or penetration test and does not claim a compliance certification.
Operators should perform their own risk assessment before using it for
production financial data.

## Report a vulnerability

Use GitHub's private vulnerability reporting:

<https://github.com/braedonsaunders/openbooks/security/advisories/new>

Do not open a public issue for a suspected vulnerability.

Include:

- affected version or commit;
- deployment configuration relevant to the issue;
- reproduction steps or a proof of concept;
- expected and observed behavior;
- likely impact and affected data;
- whether the issue is already being exploited; and
- a safe way to contact you.

The maintainers aim to acknowledge a complete report within three business days.
Investigation and remediation time depend on severity and complexity. A fix may
be released before full technical details are published.

OpenBooks does not currently operate a paid bug-bounty program.

## Security architecture

The repository implements defense-in-depth controls including:

- forced PostgreSQL row-level security for organization-owned tables;
- an isolated migration owner used only by the one-shot bootstrap, with web
  and worker processes restricted to a `NOSUPERUSER NOBYPASSRLS` runtime role;
- fail-closed runtime role checks that refuse production startup when the
  login, or a role it can assume, can defeat tenant isolation;
- server-side RBAC and permission checks;
- scoped, hashed API keys;
- scrypt password hashing and signed, server-side revocable session cookies;
- PostgreSQL-backed login throttling, temporary lockout, and authentication
  events that store keyed email/network hashes rather than raw identifiers;
- TOTP MFA with encrypted secrets, anti-replay steps, and hashed one-time
  recovery codes;
- OIDC authorization-code SSO with state, nonce, PKCE, discovery issuer checks,
  asymmetric JWKS verification, and verified-email existing-user linking;
- encryption of stored connection secrets with `OPENBOOKS_DATA_KEY`;
- database constraints for balanced postings and closed periods;
- a SELECT-only database role for the SQL workbench;
- sandboxed JavaScript execution;
- rate limits and event/audit records on sensitive surfaces; and
- idempotent deployment migrations under an advisory lock.

These controls reduce risk; they are not a warranty that the application is
free of vulnerabilities.

## Operator responsibilities

Production operators must:

- replace every example credential and keep `.env` files out of version control;
- terminate TLS at a trusted reverse proxy;
- restrict database, Redis, and object-storage ports to private networks;
- protect and rotate `SESSION_SECRET`, `OPENBOOKS_DATA_KEY`,
  `OPENBOOKS_INTERNAL_TOKEN`, database credentials, and provider secrets;
- back up PostgreSQL, object storage, and the deployment configuration;
- test restoration and upgrades on isolated infrastructure;
- restrict administrative access;
- monitor health, authentication, audit, worker, database, and backup events;
- keep the host, container runtime, images, and dependencies patched; and
- verify legal, tax, privacy, retention, and residency requirements for their
  jurisdiction.

The included Compose stack is designed for evaluation and a single-host
deployment. High-availability, regulated, or internet-exposed installations
need an operator-designed production architecture.

When enabling `OPENBOOKS_TRUST_PROXY`, the proxy must remove client-supplied
`X-Forwarded-For`, `X-Real-IP`, and `CF-Connecting-IP` headers before setting
trusted values. Otherwise leave it disabled; identity lockout remains active.
OIDC deployments must use HTTPS, protect the optional client secret, register
only the documented callback URI, and configure the provider to return a
verified email claim. OIDC does not create or reactivate users.

## Disclosure

Please avoid accessing data that is not yours, disrupting a service, retaining
sensitive data, or using social engineering. Stop testing and report the issue
if you encounter real user or financial information.
