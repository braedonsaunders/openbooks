import assert from "node:assert/strict";
import test from "node:test";
import { hrmSignatureRequestEmail, hrmSurveyInvitationEmail } from "./index";

test("signature requests name the document and carry the link in both parts", () => {
  const email = hrmSignatureRequestEmail({
    orgName: "Acme Corp",
    docTitle: "Offer letter",
    signerName: "Eddie",
    signUrl: "https://books.example.com/sign/abc123",
    expiresDate: "2026-10-21",
  });
  assert.ok(email.subject.includes("Offer letter"));
  assert.ok(email.html.includes("https://books.example.com/sign/abc123"));
  assert.ok(email.text.includes("Sign here: https://books.example.com/sign/abc123"));
  assert.ok(email.text.includes("If someone else must sign first"));
});

test("survey invitations state the anonymity grade honestly", () => {
  const anon = hrmSurveyInvitationEmail({
    orgName: "Acme Corp",
    surveyName: "Engagement",
    anonymity: "anonymous",
    respondUrl: "https://books.example.com/survey/xyz",
  });
  assert.ok(anon.text.includes("anonymous: your response is stored with no link back to you"));
  const named = hrmSurveyInvitationEmail({
    orgName: "Acme Corp",
    surveyName: "Exit",
    anonymity: "named",
    respondUrl: "https://books.example.com/survey/xyz",
  });
  assert.ok(named.text.includes("named: your response is linked to you"));
  assert.ok(named.html.includes("https://books.example.com/survey/xyz"));
});
