# Shared customer email inbox design

## Intent

Customer support needs to read mail sent to `customersupport@reply.us-seel.com` and reply from that same mailbox inside the existing support admin. Agents should see a conversation, assign an owner, track unread work, leave private notes, and connect a conversation to a Shipping Protection claim. The existing order and protection notification senders remain separate.

## Goals and boundaries

- Bring incoming customer email and staff replies into one searchable, shared workspace so agents can take ownership without switching to Alibaba Mail.
- Keep the exact customer address visible at reply time, preserve the conversation history, and let agents open a related protection claim when one is known.
- Do not turn email into an automatic claim decision, send automatic customer replies, or merge unrelated messages because two customers share an address or subject.
- Do not replace the existing ticket system, DirectMail notification workflow, or Alibaba Mail's own mailbox. The first release does not import historical Sent, Spam, or arbitrary folders.

## Approaches

1. **Direct IMAP/SMTP integration in the current support system (selected by the request).** One admin login and one customer context. Requires a mailbox sync worker and a local conversation store.
2. **Run Chatwoot beside the current admin.** Mature conversation features, but adds a second application, separate users and data, and a reconciliation step for claims. The requested page would mostly be a link or embedded view.
3. **Link to Alibaba Mail webmail.** Smallest change, but cannot offer local assignment, notes, claim links, or an integrated conversation view.

## First release

- Add a **客服收件箱** entry in the existing admin navigation. Build the interactive page with React and TypeScript using the project's existing frontend build pipeline; the HTML file is only an authenticated mount shell. Its desktop view has a conversation list, the selected message history and reply composer, and a compact context panel. On narrow screens, list and conversation become separate views with a back action.
- List filters: open, assigned to me, unassigned, resolved; search sender, subject, message text, claim reference and order reference. Show unread count, latest message time, assignee, and linked claim.
- Incoming mail appears in one conversation using `Message-ID`, `In-Reply-To`, and `References`. A reply to a protection notification with `status='sent'` can identify its outbox row by `message_id`. Show that notification's original subject, send time, and safe text body in the conversation; its `claim_id` links to a claim, while shipment/completion notifications without a `claim_id` link only to the protection order. Only auto-link the claim or order when the inbound sender matches the notification's recorded recipient. If the message was forwarded or the sender differs, show the possible link for an agent to confirm. References found in subject/body and sender email alone are also suggestions, never proof of identity. An agent can explicitly link or unlink one claim; record who changed it and when.
- Agents can assign a conversation, mark it resolved/reopen it, mark it read, and add private notes. Notes appear in the conversation history with clear styling and are never sent by email. An incoming reply reopens a resolved conversation.
- Agents can send a plain-text reply from `Customer Support <customersupport@reply.us-seel.com>`. The composer displays the exact recipient address before sending, especially when the sender differs from a linked notification's recipient; it never substitutes an order's customer address silently. Show a clear send state and the agent who sent it. Keep the sent email in the same conversation. Use `In-Reply-To` and `References` so the customer's mail client keeps its thread.
- Show inbound photo/document attachments as authenticated downloads and allow attachments on replies. Accept JPEG, PNG, WebP, and PDF only, at most 10 MB per file, 6 files per message, and 25 MB total per message. Check the actual file signature as well as declared MIME type. Store bytes outside public `/uploads` paths, with generated names and no inline browser rendering. Reject disallowed or over-limit outbound files; for inbound files retain only safe metadata and indicate that the attachment was omitted. Do not load remote images or execute HTML from incoming mail. Convert HTML-only mail to readable text.
- The first release imports the mailbox INBOX, not arbitrary folders. Replies sent through the admin appear immediately; a message sent separately from Alibaba Mail webmail is outside the local history unless a later Sent-folder sync is added.

## Mail connection and data

- Use Alibaba Mail's encrypted IMAP at `imap.qiye.aliyun.com:993` for polling, and encrypted SMTP at `smtp.qiye.aliyun.com:465` for agent replies. The mailbox needs third-party client access and an independently generated client security password. Put credentials only in ignored server environment configuration, never in the browser, database, logs or Git.
- A background worker polls approximately once a minute. Store mailbox UIDVALIDITY and last processed UID, plus a unique mailbox/UID or Message-ID key, so restarts do not import the same mail twice. Handle UIDVALIDITY reset by re-scanning a bounded recent window and deduplicating. Do not mark messages read in Alibaba Mail just because the worker fetched them.
- Persist conversations, messages, attachments, notes, assignments, claim links, and sync state in new tables. Keep attachment bytes in private storage with an authenticated download endpoint. Do not expose raw MIME or unrestricted HTML to admin pages.
- Queue outbound replies with a stable generated Message-ID and an idempotency key for each send action. If SMTP accepts but local confirmation is lost, show an **unknown** state requiring staff verification before retrying; do not automatically risk a duplicate customer reply.
- The existing dedicated DirectMail sender keeps sending order and protection notifications. Its `Reply-To` remains `customersupport@reply.us-seel.com`. The new SMTP transport is only for replies written in the inbox.

## Access, safety and operations

- Reuse the existing admin session and agent identities. Every inbox API and attachment download requires authentication; updates check request origin and expected conversation version to prevent cross-site writes and stale agents overwriting each other.
- Limit MIME message and attachment sizes before parsing, cap displayed body length, normalize addresses, and escape all customer-controlled text. Block remote content. Keep the email attachment policy separate from the existing public evidence upload policy.
- Surface sync connectivity, last successful sync, and safe error categories to admins without exposing passwords or raw provider responses. A disabled/unconfigured mailbox shows a setup state, not a broken page. New inbox email does not alter existing ticket messages or claim review decisions.
- Start with recent mail only, then keep up incrementally. Do not send customer email during deployment or schema migration. Enable live polling and replies only after the mailbox credentials work and a user-owned test message verifies both directions.

## Builder decisions

- Import the latest 30 days from INBOX on first connection, then maintain an incremental cursor. An admin can request an older backfill separately if needed.
- Use one shared mailbox for the first release. New inbound conversations start open and unassigned; an agent's first reply assigns that agent unless a different assignee was already set.
- Resolve links to protection records from a verified notification thread only when the incoming sender equals its recorded recipient. All other identifiers and address matches require human confirmation. The agent reply target remains the incoming sender, visibly shown in the composer.
- Keep only plain text body content in the application. Attachments use the private allowlist and limits above. If a message exceeds parsing limits, import a stub with sender, subject, timestamp, and an error flag so the conversation is still visible.

## Verification

- Unit and database tests cover MIME parsing, duplicate imports, threading, notification-to-claim association, same-email ambiguity, notes never leaving the system, claim link permissions, send idempotency, and SMTP failure/unknown states.
- Browser checks cover desktop and mobile list/conversation flow, unread and assignment state, safe attachment download, and a reply preview. A live test with a user-owned address confirms IMAP import and SMTP reply before enabling routine use.

## Open setup dependency

The owner must enable third-party IMAP/SMTP access for `customersupport@reply.us-seel.com` and generate that account's client security password. The application can be built and tested with fixtures before the secret is provided, but live sync and replies cannot be verified or enabled without it.
