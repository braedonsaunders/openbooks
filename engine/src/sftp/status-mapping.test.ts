import assert from "node:assert/strict";
import test from "node:test";
import { sftpFailureMessage, sftpStatusForError } from "./server.ts";

// Numeric pins are the SFTP protocol's status codes (draft-ietf-secsh-filexfer):
// 2 = NO_SUCH_FILE, 3 = PERMISSION_DENIED, 4 = FAILURE.
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;

function coded(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

test("genuine absence reads NO_SUCH_FILE", () => {
  assert.equal(sftpStatusForError(coded("ENOENT", "ENOENT: no such file or directory")), NO_SUCH_FILE);
  assert.equal(sftpStatusForError(Object.assign(new Error("NoSuchKey: the key does not exist"), { name: "NoSuchKey" })), NO_SUCH_FILE);
  assert.equal(
    sftpStatusForError(Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } })),
    NO_SUCH_FILE,
  );
});

test("permission refusals read PERMISSION_DENIED, never absent", () => {
  assert.equal(sftpStatusForError(coded("EACCES", "EACCES: permission denied")), PERMISSION_DENIED);
  assert.equal(sftpStatusForError(coded("EPERM", "EPERM: operation not permitted")), PERMISSION_DENIED);
  assert.equal(sftpStatusForError(new Error("path escapes root")), PERMISSION_DENIED);
  assert.equal(
    sftpStatusForError(Object.assign(new Error("AccessDenied: access denied"), { $metadata: { httpStatusCode: 403 } })),
    PERMISSION_DENIED,
  );
});

test("outages and unexpected storage errors read FAILURE, never absent", () => {
  assert.equal(sftpStatusForError(Object.assign(new Error("socket timed out"), { name: "TimeoutError" })), FAILURE);
  assert.equal(sftpStatusForError(coded("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.9:9000")), FAILURE);
  assert.equal(sftpStatusForError(coded("EISDIR", "EISDIR: illegal operation on a directory")), FAILURE);
  assert.equal(
    sftpStatusForError(Object.assign(new Error("InternalError"), { $metadata: { httpStatusCode: 500 } })),
    FAILURE,
  );
  assert.equal(sftpStatusForError(new Error("boom")), FAILURE);
});

test("the FAILURE message names the operation and the error class, never server paths", () => {
  const message = sftpFailureMessage(coded("EISDIR", "EISDIR: illegal operation on a directory, read '/data/sftp/tenant/x'"), "open");
  assert.match(message, /^open failed \(EISDIR\)/);
  assert.match(message, /retry/);
  assert.doesNotMatch(message, /\/data\/sftp/);
});
