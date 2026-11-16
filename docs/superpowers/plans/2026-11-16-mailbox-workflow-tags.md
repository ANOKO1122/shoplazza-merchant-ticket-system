# Mailbox workflow and customer tags

Goal: Search from the top bar; filter all/unhandled/handled independently of read state; edit and filter shared customer tags without leaving the inbox.

Architecture: Derive handling status from the latest incoming or successfully sent outgoing message, ordered by sent_at and id. Keep unread_count independent. Store tag definitions and assignments per normalized customer email; use a customer tag revision to reject concurrent overwrites. Reuse existing authenticated same-origin mailbox API and React dialogs.

- [x] Add database regression tests for handling status, search, shared tags, filtering and stale revisions.
- [x] Extend mailbox schema/store/routes with tag persistence and computed status. Preserve existing order links and email sending behavior.
- [x] Move search to top bar, add horizontal processing tabs and separate read/assignee/tag filters. Add customer-tag dialog with create, select, remove and save.
- [x] Run database tests, full suite, build, desktop/mobile interaction checks; deploy without backup, verify health and assets, commit as ANOKO1122 and push anoko/main.

Validation: npm test passed (546 tests; 22 environment-gated tests skipped). The three mailbox PostgreSQL integration suites were separately enabled and passed. Browser checks with an isolated PostgreSQL database passed at 1440px and 390px, including shared tags, stale-version handling, combined filters and search.
