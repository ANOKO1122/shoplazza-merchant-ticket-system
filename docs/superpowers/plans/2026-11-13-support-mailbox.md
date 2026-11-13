# Shared Customer Email Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared support mailbox to the existing admin so agents can read incoming email, reply as `customersupport@reply.us-seel.com`, assign work, leave private notes, and link protection claims.

**Architecture:** A single IMAP polling worker imports INBOX into PostgreSQL; the admin reads and updates local conversations through authenticated APIs. SMTP sends only staff replies from a durable outbox. Customer content is rendered as escaped plain text, and allowed attachments are stored privately.

**Tech Stack:** Node 20, TypeScript, Express, PostgreSQL, ImapFlow, postal-mime, Nodemailer, plain admin HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-11-13-support-mailbox-design.md`

## Global Constraints

- Mailbox: `customersupport@reply.us-seel.com`; IMAP `imap.qiye.aliyun.com:993` and SMTP `smtp.qiye.aliyun.com:465`, both encrypted.
- Import the latest 30 days from INBOX on first connection; poll around once a minute without setting remote `\Seen`.
- Accept JPEG, PNG, WebP and PDF attachments only, at most 10 MB each, 6 per message and 25 MB total; store outside public `/uploads`.
- Auto-link a protection record from a `sent` notification thread only when inbound sender matches the recorded recipient. Otherwise show a candidate requiring staff confirmation.
- No automatic customer replies, automatic claim decisions, historic Sent-folder sync, or changes to DirectMail notification transport.
- Credentials live only in ignored server environment configuration; never expose them in API responses, logs, Git or browser code.

## File Map

- `support-system/src/mailbox-schema.ts`: tables and indexes.
- `support-system/src/mailbox-domain.ts`: address/header normalization, attachment validation, thread matching decisions.
- `support-system/src/mailbox-store.ts`: transactional message import, conversation operations, claim link candidates, send outbox.
- `support-system/src/mailbox-imap.ts`: bounded IMAP polling, UID cursor, parsing, error status.
- `support-system/src/mailbox-smtp.ts`: SMTP send worker and delivery state.
- `support-system/src/mailbox-routes.ts`: authenticated APIs and private attachment downloads.
- `support-system/public/admin-mailbox.html`: shared inbox UI.
- `support-system/src/index.ts`, `pg.ts`, `admin-pages.ts`, `public/admin-shell.js`, `.env.example`, `package.json`: mounting, schema initialization, navigation, dependencies and configuration.

## Review Focus

- A forwarded reply has the right `In-Reply-To` but a different sender: candidate link only and recipient shown before send (Task 2, Task 4).
- Two messages share a `Message-ID` or IMAP UID is replayed: exactly one stored message (Task 2, Task 3).
- SMTP accepts a reply but process fails before acknowledging: state becomes unknown and no automatic duplicate send (Task 4).
- A malformed/huge MIME email arrives: import a visible stub while rejecting unsafe attachments and continuing sync (Task 3).
- Two agents edit one conversation concurrently: stale mutation is rejected with a version conflict (Task 2, Task 5).

---

### Task 1: Data and pure mail rules

**Files:** Create `mailbox-schema.ts`, `mailbox-domain.ts`, `mailbox-domain.test.ts`; modify `pg.ts`.

**Interfaces:** `initMailboxSchema(): Promise<void>`; `parseMailHeaders(...)`, `attachmentPolicy(...)`, `matchNotificationThread(...)` in `mailbox-domain.ts`.

- [ ] Write tests for sender normalization, reply references, exact-recipient automatic link, changed-sender candidate, allowed file signatures, and size limits.
- [ ] Run `npx tsx --test src/mailbox-domain.test.ts`; confirm failures.
- [ ] Implement rules and tables for sync state, conversations, messages, attachments, notes, claim links and outbound state; invoke schema initialization from the established `ensureTables` path.
- [ ] Run focused tests and `npm run build`; confirm pass.
- [ ] Commit.

### Task 2: Conversation persistence and staff actions

**Files:** Create `mailbox-store.ts`, `mailbox-store.test.ts`.

**Interfaces:** `importIncomingMessage(input)`, `listConversations(filters)`, `getConversation(id)`, `updateConversation(id, version, change, agent)`, `addNote(id, version, text, agent)`, `linkClaim(id, version, claimId, agent)`, `queueReply(id, version, recipient, text, attachments, agent, idempotencyKey)`.

- [ ] Write database tests for deduplicated import, notification context, unrelated same-email messages, unread/reopen, assignment, notes, claim link audit, search and stale version.
- [ ] Run focused test; confirm failure.
- [ ] Implement transactional store methods and query limits; keep conversation message bodies as text only and replies in outbox until sent.
- [ ] Run focused test and build; confirm pass.
- [ ] Commit.

### Task 3: IMAP importer and private attachment storage

**Files:** Create `mailbox-imap.ts`, `mailbox-attachments.ts`, focused tests; modify `index.ts`, `.env.example`, `package.json` and lockfile.

**Interfaces:** `syncMailboxOnce()`, `startMailboxSync()`, `saveMailboxAttachment(...)`, `readMailboxAttachment(...)`.

- [ ] Write tests for first 30-day import, UIDVALIDITY reset, duplicate UID/Message-ID, malformed MIME stub, safe attachment policy, and no remote read mutation.
- [ ] Run focused tests; confirm failure.
- [ ] Install ImapFlow and postal-mime; implement bounded source fetch with read-only mailbox lock, one-minute polling, cursor update only after successful import, and connection status.
- [ ] Run focused tests and build; confirm pass.
- [ ] Commit.

### Task 4: Reply outbox and authenticated API

**Files:** Create `mailbox-smtp.ts`, `mailbox-routes.ts`, focused tests; modify `index.ts`.

**Interfaces:** `processMailboxReplies()` and `/api/admin/mailbox/*` endpoints for status, list, detail, read/assign/resolve, note, link, reply, and attachment download.

- [ ] Write tests for auth, origin check, exact recipient, idempotency, `In-Reply-To`/`References`, SMTP failure/unknown state, and private attachment download.
- [ ] Run focused tests; confirm failure.
- [ ] Implement SMTP transport and API with bounded inputs, optimistic versions, safe errors and an explicit unknown send state.
- [ ] Run focused tests and build; confirm pass.
- [ ] Commit.

### Task 5: Shared inbox page

**Files:** Create `public/admin-mailbox.html`; modify `admin-pages.ts`, `public/admin-shell.js`, `index.ts`; add a focused frontend smoke test if existing test harness supports it.

**Interfaces:** `/thinkpro-admin/mailbox` uses Task 4 APIs.

- [ ] Add a failing navigation/page access test and UI behavior test for filters, opening conversation, reading, note/reply separation, assignment, linking and visible reply target.
- [ ] Run tests; confirm failures.
- [ ] Implement desktop list/conversation/context layout and narrow-screen list/detail layout, plus loading, empty, connectivity, conflict and send states.
- [ ] Run tests, build and manual browser checks; confirm pass.
- [ ] Commit.

### Task 6: End-to-end verification and rollout

**Files:** Update operator documentation and test fixtures only as needed.

- [ ] Run `npm test` and `npm run build` in `support-system`; address any failures.
- [ ] Send a message from a user-owned test address to the mailbox and verify IMAP import, protection association, staff reply, SMTP history, and attachment access after credentials are configured.
- [ ] Verify no customer email is sent by migration/startup alone; deploy, check health and mailbox status, then push current branch to `anoko` with author `ANOKO1122`.
