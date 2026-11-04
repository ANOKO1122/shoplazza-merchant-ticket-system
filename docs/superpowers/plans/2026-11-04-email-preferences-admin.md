# Email unsubscribe visibility implementation plan

**Goal:** Let staff see which email has unsubscribed from each system, show the system footer in template previews, and use exactly `Unsubscribe` as the email link label.

**Architecture:** Keep the existing address/category preference storage and capability-based confirmation. Add a protected, read-only staff page and listing API; display one row per email with independent ticket/protection timestamps. Reuse one pure footer renderer for actual delivery and inert template previews. Existing staff design and dependencies are retained.

**Scope supplied by the user:** Explain the opaque `token=eu_…` mapping (already answered), add staff visibility, fix missing template-preview footer, shorten the link label. The page will search partial email addresses and filter by system, with pagination. No preference reset, export, new mail trigger, or SMTP activation is included.

## Tasks

- [x] Backend: `src/email-preferences-admin-routes.ts` provides `createEmailPreferencesAdminRouter()` and protected GET listing at `/api/admin/email-preferences`, mounted after the existing agent authentication. Validate q/category/page/page_size; query normalized preferences with literal wildcard escaping and stable latest-first pagination. Return grouped rows, filtered total and global category counts. Verify authorization, search, category isolation, dates, pagination, empty results and no token exposure with offline HTTP and isolated PostgreSQL tests.
- [x] Staff interface: `public/admin-email-preferences.html`, existing shell navigation and protected page mappings. Route `/thinkpro-admin/email-preferences`; Chinese label `邮件退订`. Show email, separate system status/timestamps, search, category filters and pagination; handle loading, failure, empty results, stale response races and session expiration. Existing sidebars must receive the link, including adopted server-rendered shells. Check desktop/mobile using synthetic fixtures.
- [x] Footer/preview: refactor pure rendering in `src/email-preferences.ts`, show only `Unsubscribe` in the mail footer. Update valid queued footers without rotating tokens. Admin template preview and the actual editor preview display the same inert footer and explain automatic insertion. Keep editable templates free of tokens; all previews must remain read-only and must classify the two protection templates correctly. Add regression checks for unchanged delivery bindings and stale preview responses.
- [x] Integration: run targeted tests, relevant database checks, full test command and build; review final changes, deploy only support-bridge while keeping protection SMTP disabled, verify authenticated page/API boundaries and live public confirmation routes. Update operations notes and commit the completed change.

## API contract

`GET /api/admin/email-preferences?q=&category=all&page=1&page_size=25`

`category` is `all`, `ticket` or `protection`; page size 1–100. Items have `email`, nullable `ticket_unsubscribed_at`, nullable `protection_unsubscribed_at`, and `last_unsubscribed_at`. Response includes `{ok,items,total,page,page_size,summary:{email_count,ticket_count,protection_count}}`. Summary counts are global; total/items follow search and category. Only email addresses with at least one recorded unsubscribe are listed. No capability values or hashes are returned.

## Review focus

Same email can have two timestamps but only one row; `ticket` filter still displays the protection status accurately. Search `%`, `_` and backslash are literal characters, not wildcard instructions. Unauthenticated users and the customer domain cannot access staff data. Preview links cannot change a real preference. SPA navigation cannot leave stale results or hide the newly added menu. Existing and new queued messages keep valid unsubscribe bindings after the label change.

## Result

Implemented and deployed `support-bridge:email-preferences-admin-20261104`. Full suite: 459 backend passes, 15 environment-dependent skips, 24 frontend passes; targeted PostgreSQL listing/auth4/4, preference10/10 and notification13/13 checks passed. Bounded review reported no P1/P2 findings; synthetic browser checks covered desktop/mobile listing and real template-preview rendering/switches. Production authentication, public routes and read-only module checks passed. Protection SMTP remains disabled. No real test emails or production unsubscribe records were created.
