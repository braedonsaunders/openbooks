import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const CERTIFICATE =
  process.env.G37_CERTIFICATE_UNDER_TEST ??
  fileURLToPath(
    new URL("./project-parity-certificate.ts", import.meta.url),
  );

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

interface Fixture {
  dir: string;
  files: Record<string, string>;
}

function writeCapture(fixture: {
  projects: unknown[];
  financials: unknown[];
  headers?: string;
}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "parity-capture-"));
  const files: Record<string, string> = {
    sourceProjects: join(dir, "projects.json"),
    sourceInvoices: join(dir, "invoices.json"),
    sourceInvoiceLines: join(dir, "invoice-lines.json"),
    sourceProjectGl: join(dir, "project-gl.json"),
    sourceProjectFinancials: join(dir, "financials.json"),
    snapshot: join(dir, "capture.snapshot.json"),
    out: join(dir, "certificate.json"),
  };
  writeFileSync(files.sourceProjects!, JSON.stringify(fixture.projects));
  writeFileSync(files.sourceInvoices!, JSON.stringify([]));
  writeFileSync(files.sourceInvoiceLines!, JSON.stringify([]));
  writeFileSync(files.sourceProjectGl!, JSON.stringify([]));
  writeFileSync(files.sourceProjectFinancials!, JSON.stringify(fixture.financials));
  if (fixture.headers !== undefined) {
    files.fieldTicketHeaders = join(dir, "headers.tsv");
    writeFileSync(files.fieldTicketHeaders, fixture.headers);
  }
  const now = new Date().toISOString();
  const artifacts: Record<string, { path: string; sha256: string }> = {};
  for (const [key, path] of Object.entries(files)) {
    if (key === "snapshot" || key === "out") continue;
    artifacts[key] = { path, sha256: sha256(path) };
  }
  writeFileSync(
    files.snapshot!,
    JSON.stringify({
      schemaVersion: 1,
      source: "configured_accounting_source",
      startedAt: now,
      completedAt: now,
      sourceAccountingBook: "1",
      artifacts,
    }),
  );
  return { dir, files };
}

interface GateView {
  status: string;
  detail?: string;
}

interface CertificateView {
  gates: Record<string, GateView>;
  fatal?: string;
}

function gate(certificate: CertificateView, name: string): GateView {
  const found = certificate.gates[name];
  assert.ok(
    found,
    `certificate is missing gate ${name}${certificate.fatal ? `: ${certificate.fatal}` : ""}`,
  );
  return found;
}

function runCertificate(
  orgId: string,
  files: Record<string, string>,
  extraArgs: string[] = [],
): Promise<{ code: number | null; certificate: CertificateView }> {
  return new Promise((resolve) => {
    const args = [
      CERTIFICATE,
      `--org=${orgId}`,
      `--source-projects=${files.sourceProjects}`,
      `--source-invoices=${files.sourceInvoices}`,
      `--source-invoice-lines=${files.sourceInvoiceLines}`,
      `--source-project-gl=${files.sourceProjectGl}`,
      `--project-financials=${files.sourceProjectFinancials}`,
      `--source-snapshot=${files.snapshot}`,
      `--out=${files.out}`,
      "--allow-differences",
      ...extraArgs,
    ];
    if (files.fieldTicketHeaders) {
      args.push(
        `--field-ticket-headers=${files.fieldTicketHeaders}`,
        "--field-ticket-source-system=capturetest",
      );
    }
    const child = fork(args[0]!, args.slice(1), {
      execArgv: [
        "--no-concurrent-sparkplug",
        "--no-concurrent-recompilation",
        "--import",
        "tsx",
        "--import",
        "./engine/src/testing/database-bypass.ts",
      ],
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let err = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, certificate: { gates: {}, fatal: "child timed out" } });
    }, 240_000);
    child.on("error", (error) => {
      clearTimeout(watchdog);
      resolve({ code: null, certificate: { gates: {}, fatal: error.message } });
    });
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      try {
        resolve({
          code,
          certificate: JSON.parse(readFileSync(files.out!, "utf8")) as CertificateView,
        });
      } catch {
        resolve({
          code,
          certificate: {
            gates: {},
            fatal: `no certificate; stderr: ${err.slice(-500)}`,
          },
        });
      }
    });
  });
}

const projects = [
  { id: "1", entityid: "P1", companyname: "Project One", isinactive: "F" },
];

const freshFinancials = () => [
  {
    job: "1",
    cost: "10.5000",
    price: "20.0000",
    invoiced: "5.0000",
    fetchedAt: new Date().toISOString(),
  },
];

test("an unmodified capture still certifies coherence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { files } = writeCapture({ projects, financials: freshFinancials() });
    const { code, certificate } = await runCertificate(org.orgId, files);
    assert.equal(code, 0);
    assert.equal(gate(certificate, "sourceSnapshotCoherence").status, "exact");
    assert.match(
      gate(certificate, "sourceSnapshotCoherence").detail ?? "",
      /hash-bound/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a tampered financial amount fails provenance, not exact", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { files } = writeCapture({ projects, financials: freshFinancials() });
    // Edit the amount after capture, keeping job IDs and fetchedAt intact.
    const rows = JSON.parse(
      readFileSync(files.sourceProjectFinancials!, "utf8"),
    ) as Array<Record<string, unknown>>;
    rows[0]!.cost = "9999.0000";
    writeFileSync(files.sourceProjectFinancials!, JSON.stringify(rows));
    const { code, certificate } = await runCertificate(org.orgId, files);
    assert.equal(code, 0);
    const coherence = gate(certificate, "sourceSnapshotCoherence");
    assert.equal(coherence.status, "unproven");
    assert.match(
      coherence.detail ?? "",
      /sourceProjectFinancials hash changed after source capture/,
    );
    assert.notEqual(
      gate(certificate, "sourceProjectFinancialMeasures").status,
      "exact",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an artifact with no capture hash refuses by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { files } = writeCapture({ projects, financials: freshFinancials() });
    const snapshot = JSON.parse(readFileSync(files.snapshot!, "utf8")) as {
      artifacts: Record<string, unknown>;
    };
    delete snapshot.artifacts.sourceProjectFinancials;
    writeFileSync(files.snapshot!, JSON.stringify(snapshot));
    const { code, certificate } = await runCertificate(org.orgId, files);
    assert.equal(code, 0);
    const coherence = gate(certificate, "sourceSnapshotCoherence");
    assert.equal(coherence.status, "unproven");
    assert.match(
      coherence.detail ?? "",
      /sourceProjectFinancials \(.*\) has no capture hash/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a field-ticket TSV edited after capture fails the same way", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const headers = [
      "1\tFT-1\t1\tE1\tC1\t01/06/2024\t01/12/2024\tNo\tNo\tYes\tF1\tNULL\tWeek one",
    ].join("\n");
    const { files } = writeCapture({
      projects,
      financials: freshFinancials(),
      headers,
    });
    writeFileSync(
      files.fieldTicketHeaders!,
      [
        "1\tFT-1-EDITED\t1\tE1\tC1\t01/06/2024\t01/12/2024\tNo\tNo\tYes\tF1\tNULL\tWeek one",
      ].join("\n"),
    );
    const { code, certificate } = await runCertificate(org.orgId, files);
    assert.equal(code, 0);
    const coherence = gate(certificate, "sourceSnapshotCoherence");
    assert.equal(coherence.status, "unproven");
    assert.match(
      coherence.detail ?? "",
      /fieldTicketHeaders hash changed after source capture/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
