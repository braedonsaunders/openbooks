# HA-ready application-tier reference

This directory is a Kubernetes reference for running more than one OpenBooks
web and worker process. It is not, by itself, a highly available OpenBooks
deployment. Overall availability is bounded by PostgreSQL, Redis, object
storage, ingress/DNS, secrets, and the cluster control plane.

The ordinary `compose.yaml` remains a single-host evaluation/small-deployment
topology. Adding Compose replicas on the same host does not remove that host as
a failure domain.

## External prerequisites

Provide and test:

- PostgreSQL 16 with automated failover, backups/PITR, connection limits, and a
  constrained runtime role separate from the schema owner;
- a Redis topology supported by BullMQ, with authentication, persistence,
  failover, and alerting;
- S3-compatible object storage with versioning/replication and tested recovery;
- a TLS ingress/load balancer with health-based routing;
- ingress rules that overwrite (rather than append untrusted) forwarding
  headers, plus network policy preventing clients from bypassing that ingress;
- a secret manager and rotation procedure;
- at least two Kubernetes nodes/failure zones for pod spreading; and
- centralized logs, metrics, traces, alerts, and an on-call runbook.

Validate each provider's consistency and failover behavior with OpenBooks.
These manifests do not install or claim HA for those dependencies.

## Secrets

Create secrets out of band. Do not commit values or leave them in shell history.
`openbooks-runtime` must provide:

- `OPENBOOKS_DB_URL`
- `OPENBOOKS_REDIS_URL`
- `SESSION_SECRET`
- `OPENBOOKS_DATA_KEY`
- `OPENBOOKS_INTERNAL_TOKEN`
- `S3_ENDPOINT`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

`openbooks-bootstrap` must provide `OPENBOOKS_MIGRATION_DB_URL` and
`OPENBOOKS_RUNTIME_DB_URL`. The migration URL is exposed only to the one-shot
Job. For a first installation it must also provide `ORG_CURRENCY` and
`ORG_COUNTRY`, and may provide `ORG_NAME`, `ADMIN_EMAIL`, `ADMIN_NAME`, and
`ADMIN_PASSWORD`. The Job
references those keys individually; it does not receive the broad runtime
secret containing session, data, S3, Redis, and internal-service credentials.

## Deploy or upgrade

The manifests deliberately use an unreachable `example.invalid` image and a
zero digest. Do not substitute a historical OpenBooks package. In
`image/kustomization.yaml`, change the single `newName`/`digest` entry only to
an immutable multi-platform image built from the remediated clean-history
source and accepted by post-build security/privacy scans. Both overlays consume
that one component, so bootstrap, web, and worker cannot drift through three
independent edits.

For every install or upgrade, including a retry, use this sequence:

```bash
# A completed Job's pod template is immutable. Force a fresh execution for
# this release; never rely on ttlSecondsAfterFinished to have removed it.
kubectl delete job openbooks-bootstrap --ignore-not-found --wait=true
kubectl apply -k deploy/ha/bootstrap
kubectl wait --for=condition=complete job/openbooks-bootstrap --timeout=15m
kubectl logs job/openbooks-bootstrap > /secure/deploy-evidence/openbooks-bootstrap.log

# Only roll application pods after schema bootstrap completed successfully.
kubectl apply -k deploy/ha/runtime
kubectl rollout status deployment/openbooks-web --timeout=10m
kubectl rollout status deployment/openbooks-worker --timeout=10m
```

There is intentionally no `deploy/ha/kustomization.yaml`: applying the whole
directory cannot accidentally start a new application revision before its
bootstrap Job succeeds.

Set the public URL, region, bucket, and proxy policy in
`deploy/ha/base/configuration/configuration.yaml` before rendering.
`OPENBOOKS_TRUST_PROXY=1` is safe only when the Service cannot
be reached around the ingress and that ingress replaces client-supplied
forwarding headers. The runtime overlay installs a default-deny ingress policy;
use a Kubernetes network provider that actually enforces `NetworkPolicy`.
Before rollout, label both the trusted ingress-controller namespace and its
controller pods `openbooks.network/trusted-proxy=true`; until both labels match,
public traffic fails closed. Configure TLS ingress to `openbooks-web`, preserve the Job
logs and rendered image digest as evidence, then verify readiness, per-pod
worker probes, deployment-wide worker heartbeat, queue processing, object
access, and representative accounting/report workflows.

The bootstrap itself also takes the OpenBooks PostgreSQL deployment advisory
lock, but sequencing the Job before the Deployments keeps failure visible and
prevents a new application revision from racing an incomplete migration.

Web liveness is process-only, while web readiness checks PostgreSQL, Redis, and
the configured object-store bucket. Each worker writes distinct local liveness
and dependency-readiness markers; Kubernetes therefore observes each worker
pod rather than relying only on the deployment-global Redis heartbeat. The
Deployments use three web pods and two workers, pod anti-affinity, topology
spread, rolling updates, disruption budgets, non-root execution, read-only root
filesystems, and bounded resources. Tune replicas and resources from measured
load; more workers are not automatically better for every accounting workload.

## Failure testing

Before calling the resulting system HA, test at least:

- loss of a web pod, worker pod, node, and availability zone;
- PostgreSQL primary failover during reads, writes, and posting;
- Redis failover with queued and in-flight work;
- object-store and DNS/network interruption;
- a bootstrap Job failure before rollout;
- backup restoration into a separate cluster; and
- recovery while a posting or integration job is in flight.

Measure error rate, recovery time, duplicate/missing work, queue lag, and ledger
invariants. Document residual single points of failure and compare measured
results with the declared RPO, RTO, and service objective.
