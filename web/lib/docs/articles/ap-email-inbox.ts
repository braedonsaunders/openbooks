import type { DocArticle } from "../types";

export const apEmailInbox: DocArticle = {
  slug: "ap-email-inbox",
  title: "AP Email Inbox and Bill Auto-Post",
  category: "transactions",
  order: 22,
  summary:
    "Receive vendor bills by email for each legal entity, connect Postmark, Mailgun, SendGrid or a generic webhook, review captures from the keyboard, and let trusted vendors post automatically.",
  updated: "2026-10-21",
  keywords: [
    "bill capture",
    "inbound email",
    "AP inbox",
    "Postmark",
    "Mailgun",
    "SendGrid",
    "webhook",
    "OCR",
    "auto-post",
    "trusted vendor",
    "keyboard",
    "accounts payable",
  ],
  related: ["purchasing-workflow", "electronic-invoicing"],
  body: `# AP Email Inbox and Bill Auto-Post

Bill capture reads vendor bills (PDF, image or XML e-invoice) and turns each one
into a capture you review beside the source document before it becomes a draft
bill. Besides the **Upload** button on **Payables → Bill capture**, bills can
arrive by email: every legal entity can have one or more inbound addresses, and
each attachment becomes a capture for that entity.

## How inbound email works

Email itself is received by an email provider you already use. The provider
posts each message to OpenBooks through a webhook URL that is unique to one
inbound address. OpenBooks then:

1. checks the address token in the URL (an unknown token is refused, an inactive
   address is refused);
2. verifies the provider signature when the address has a signing secret;
3. records the message once per message id, so a provider retry never creates a
   second set of captures;
4. checks the sender against the address's allowed senders;
5. sends each PDF, image or XML attachment through the same intake the Upload
   button uses, with the same size limits, type checks and duplicate detection.

Every message and its outcome appear on the **Inbox activity** tab of Bill
capture: **Captured**, **Sender not allowed**, **No bill attached**, **Already
captured** or **Error** with the reason.

## Create an inbound address

Open **Setup → Billing → AP inbound addresses** and choose **New**.

| Field | Meaning |
| --- | --- |
| **Subsidiary** | The legal entity whose bills arrive here. Bills captured from this address book to it. |
| **Name** | How the address is shown on the capture page. |
| **Forwarding address** | The email address vendors send to at your provider, shown with a copy button. |
| **Email provider** | Postmark, Mailgun, SendGrid or Generic JSON. |
| **Allowed senders** | Exact addresses (ap@vendor.com) or whole domains (@vendor.com). Empty accepts any sender. |
| **Signing secret** | Optional. Required by the provider-specific checks below. |

After saving, the list shows the address's webhook token. The capture page shows
the full webhook URL with a copy button; it has the form
**https://your-openbooks-host/api/inbound/ap/TOKEN**. To replace a URL that may
have leaked, edit the address and choose **Issue a new webhook URL**; the old URL
stops working at once.

## Provider setup

### Postmark

1. In Postmark, open the server's inbound message stream and set the inbound
   webhook URL to the webhook URL from OpenBooks.
2. To authenticate deliveries, add credentials to the URL, for example
   **https://inbound:SECRET@your-openbooks-host/api/inbound/ap/TOKEN**, and enter
   the same SECRET as the address's signing secret.
3. Forward vendor mail to the Postmark inbound address, or use it directly as the
   forwarding address.

### Mailgun

1. Create a route that matches the receiving address and uses the action
   **forward()** with the OpenBooks webhook URL. Attachments must arrive with the
   message; a **store()** route that sends download links instead is refused with
   that remedy.
2. Copy Mailgun's webhook signing key into the address's signing secret.
   OpenBooks checks the signature and rejects deliveries older than fifteen
   minutes.

### SendGrid

1. Under Inbound Parse, add the receiving host and set the destination URL to the
   OpenBooks webhook URL.
2. Leave **POST the raw, full MIME message** turned off; the parsed form carries
   the attachments.
3. To authenticate deliveries, put credentials in the URL as described for
   Postmark and enter the password as the signing secret.

### Generic JSON

Any system that can post JSON may deliver to the webhook URL with content type
application/json:

~~~
{
  "from": "ap@vendor.example",
  "subject": "Invoice 1042",
  "messageId": "<1042@vendor.example>",
  "attachments": [
    { "filename": "1042.pdf", "contentType": "application/pdf", "contentBase64": "JVBERi0x..." }
  ]
}
~~~

When the address has a signing secret, send the header
**X-OpenBooks-Signature: sha256=HEX**, where HEX is the HMAC-SHA256 of the exact
request body under the secret. A message without a message id is identified by
a digest of its sender, subject and attachments.

## Review from the keyboard

The capture review drawer is built for high-volume entry:

| Keys | Action |
| --- | --- |
| **J** / **K** | Next or previous capture in the current list order (outside text fields). |
| **Enter** in a field | Confirm it and jump to the next field that needs attention. |
| **⌘ Enter** / **Ctrl Enter** | Create the draft and open the next capture that needs review. |
| **⌘ Shift Enter** / **Ctrl Shift Enter** | Create the draft and post it (requires posting permission). |
| **⌘ Backspace** / **Ctrl Backspace** | Reject the capture after confirming. |
| **?** | Show every shortcut available where you are. |

A field needs attention when it is empty but required, when a validation issue
names it, or when the reader's confidence for it is below the capture confidence
threshold in **Platform → AI**. Focus starts on the first such field. Creating and
posting uses the same submit and post commands as the bill itself: an approval
Flow holds the bill for approval, and a refusal such as a closed period is shown
on the capture with the draft kept.

## Earned auto-post for trusted vendors

**Setup → Billing → Bill auto-post policy** controls automatic posting. It is
off until a version turns it on, and each version is effective from a date and
cannot be edited afterwards; record a new version to change it.

- **Clean bills required** (2 to 20, default 3): a vendor is trusted when its
  most recent captured bills, that many in a row, were each accepted without any
  review correction or later edit to the draft and were posted, with none
  voided. One correction, edit or void ends the streak.
- **Maximum amount per bill**: optional, with its currency. Larger bills, and
  bills in another currency, wait for review.

When the policy is on, a newly read bill from a trusted vendor posts
automatically only if the vendor was matched, there are no open issues, no
duplicate flag and no purchase-order exceptions. The bill is created and then
submitted and posted through the normal commands under the capture's owner (the
uploader, or for email the administrator who created the address), who must be
allowed to create and post bills. An approval Flow still applies, and a posting
refusal leaves the bill as a draft with the refusal recorded on the capture.
Every automatic post is in the audit trail with the policy version and the
captures that earned the vendor's trust, and the capture shows the vendor's
streak (for example, Trusted: 3 clean bills in a row) and the decision taken.
`,
};
