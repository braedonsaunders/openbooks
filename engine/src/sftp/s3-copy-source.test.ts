import assert from "node:assert/strict";
import test from "node:test";

const { encodeS3CopySource, s3Backend, setSftpS3ClientForTests } = await import("./backend.ts");
const { createFakeS3, sentCopies } = await import("./fake-s3.ts");

const ORG = "55555555-5555-5555-5555-555555555555";
const ROOT = `sftp/${ORG}/feedbot`;
const BUCKET = "openbooks";

test.after(() => setSftpS3ClientForTests(null));

test("CopySource URL-encodes each key segment while keeping slashes", () => {
  // The auditor's probe: a statement named with a space and '#'.
  assert.equal(
    encodeS3CopySource(BUCKET, `${ROOT}/inbound/a #1.ofx`),
    `${BUCKET}/${ROOT}/inbound/a%20%231.ofx`,
  );
  // Separators survive; nothing else in a plain key changes.
  assert.equal(encodeS3CopySource(BUCKET, "a/b/c.ofx"), `${BUCKET}/a/b/c.ofx`);
  // '+' must not become a space on the service side.
  assert.equal(encodeS3CopySource(BUCKET, "in/a+b.ofx"), `${BUCKET}/in/a%2Bb.ofx`);
  // Non-ASCII names travel as UTF-8 percent-escapes.
  assert.equal(encodeS3CopySource(BUCKET, "in/état.ofx"), `${BUCKET}/in/%C3%A9tat.ofx`);
});

test("an S3 rename sends the encoded CopySource and deletes the source", async () => {
  const fake = createFakeS3();
  setSftpS3ClientForTests(fake.client);
  const backend = s3Backend(BUCKET, ROOT, ORG);
  const source = "inbound/a #1.ofx";
  const dest = "inbound/processed/a #1.ofx";
  await backend.write(source, Buffer.from("statement-bytes"));

  await backend.rename(source, dest);

  // THE regression: the raw header 'b/a #1.ofx' made the archive COPY fail,
  // leaving the source in inbound to be re-scanned as a duplicate.
  const copies = sentCopies(fake);
  assert.equal(copies.length, 1);
  assert.equal(copies[0]!.CopySource, `${BUCKET}/${ROOT}/inbound/a%20%231.ofx`);
  assert.equal(copies[0]!.Key, `${ROOT}/${dest}`);
  assert.equal(await backend.stat(source), null);
  assert.equal((await backend.read(dest)).toString("utf8"), "statement-bytes");
});

test("an S3 rename of a plain name still round-trips", async () => {
  const fake = createFakeS3();
  setSftpS3ClientForTests(fake.client);
  const backend = s3Backend(BUCKET, ROOT, ORG);
  await backend.write("inbound/statement.ofx", Buffer.from("plain-bytes"));
  await backend.rename("inbound/statement.ofx", "inbound/processed/statement.ofx");
  const copies = sentCopies(fake);
  assert.equal(copies[0]!.CopySource, `${BUCKET}/${ROOT}/inbound/statement.ofx`);
  assert.equal((await backend.read("inbound/processed/statement.ofx")).toString("utf8"), "plain-bytes");
});
