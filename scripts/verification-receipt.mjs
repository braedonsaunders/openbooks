import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const verificationPartitions = [
  'typecheck', 'simulation', 'integration', 'restore-drill',
  ...Array.from({ length: 5 }, (_, i) => `unit (${i + 1})`),
  ...Array.from({ length: 16 }, (_, i) => `database (${i + 1})`),
  ...Array.from({ length: 3 }, (_, i) => `e2e-app (${i + 1})`),
  ...['close-and-procure', 'cash-and-tax', 'bank', 'subscription-and-project', 'inventory-and-dashboard']
    .map(group => `e2e-workflows (${group})`),
];

/** Require actual successful executions, including every matrix member. */
export function validateVerificationReceipt(receipt, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || receipt?.schemaVersion !== 1 || receipt.gitSha !== sha) {
    throw new Error('verification receipt must identify the exact full source commit');
  }
  if (!/^\d+$/.test(String(receipt.runId ?? '')) || !Number.isSafeInteger(receipt.runAttempt) || receipt.runAttempt < 1) {
    throw new Error('verification receipt must identify its workflow run and attempt');
  }
  if (!Array.isArray(receipt.partitions) || receipt.partitions.length !== verificationPartitions.length) {
    throw new Error('verification receipt is missing required execution partitions');
  }
  const names = new Set();
  for (const partition of receipt.partitions) {
    if (!verificationPartitions.includes(partition.name) || names.has(partition.name)) {
      throw new Error(`verification partition is unexpected or duplicated: ${partition.name}`);
    }
    names.add(partition.name);
    if (!Number.isSafeInteger(partition.jobId) || partition.jobId < 1 || partition.conclusion !== 'success' ||
        !Number.isFinite(Date.parse(partition.startedAt)) || !Number.isFinite(Date.parse(partition.completedAt)) ||
        Date.parse(partition.completedAt) < Date.parse(partition.startedAt)) {
      throw new Error(`verification partition did not execute successfully: ${partition.name}`);
    }
  }
  return receipt;
}

export async function collectVerificationReceipt({ repository, runId, runAttempt, sha, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(String(runId)) ||
      !Number.isSafeInteger(runAttempt) || runAttempt < 1) throw new Error('invalid workflow identity');
  const jobs = [];
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`workflow jobs could not be read (${response.status}); no receipt was issued`);
    const body = await response.json();
    if (!Array.isArray(body.jobs)) throw new Error('workflow job response has no execution evidence');
    for (const job of body.jobs) {
      if (verificationPartitions.includes(job.name) && job.head_sha !== sha) {
        throw new Error(`workflow job source does not match verification: ${job.name}`);
      }
    }
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) break;
  }
  const receipt = { schemaVersion: 1, gitSha: sha, runId: String(runId), runAttempt,
    partitions: jobs.filter(job => verificationPartitions.includes(job.name)).map(job => ({
      name: job.name, jobId: job.id, conclusion: job.conclusion,
      startedAt: job.started_at, completedAt: job.completed_at,
    })) };
  return validateVerificationReceipt(receipt, sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = await collectVerificationReceipt({ repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    sha: process.env.GITHUB_SHA, token: process.env.GITHUB_TOKEN });
  writeFileSync(process.argv[2] ?? 'verification.json', `${JSON.stringify(receipt, null, 2)}\n`);
}
