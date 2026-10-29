# Invitation expiry on ticket activation

The user approved extending an invitation only when its submission successfully creates a ticket and its first access link. Set that invitation's expiry to the exact expiry of that first ticket access token. Merely opening an invitation, replying to a ticket, issuing another invitation, or submitting the same invitation again must not extend it.

Each activated invitation must reopen the ticket it created, including a closed ticket, rather than another ticket for the same order. Unused invitations keep the existing expiry policy and order-based fallback. Existing ticket-access link issuance and email delivery remain unchanged.

## Approach

Use existing token hashes and ticket associations. Create the ticket, first access token, messages, and invitation expiry update in one PostgreSQL transaction. Lock the invitation row and recheck its identity, validity, and existing ticket to serialize concurrent submissions. No schema changes, bulk historical renewal, default expiry changes, or scheduled renewal.

Changing default invitation days alone would not align actual expiry dates. Renewing on visits or replies would violate the approved activation-only rule. The transaction and exact-ticket lookup are implementation choices needed to make that rule reliable.

Implement directly on main, commit as ANOKO1122, push and deploy, as previously authorized. Preserve unrelated local files. Verify with a disposable database; do not create test customer activity or send email in production.
