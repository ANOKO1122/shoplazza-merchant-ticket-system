# Shipping Protection Camera Evidence Implementation Plan

**Goal:** Let customers take damage photos inside the claim page, with English phone permission guides and visible manual-review exceptions.

**Design and scope:** The user requested camera capture instead of gallery uploads to deter fabricated damage evidence. Use `getUserMedia()` with rear-facing preference, a still-photo preview, retake, and explicit use-photo action. File-input `capture` is only a hint and cannot implement this requirement. Keep generic uploads for other issue types. Damage claims and their supplements use the same camera-only path. Guide customers to show the damaged item, outer packaging and shipping label; require at least one damaged-item photo. As an implementation decision, customers unable to use a camera can explain why for manual review; this does not approve the claim or enable a gallery workaround.

**Architecture:** Extend the existing private evidence upload pipeline. Issue short-lived, session/order-bound capture tickets by category; record their server timestamps and consume them atomically with idempotent uploads. These records identify the guided capture workflow, not proof of real-world authenticity. Browsers cannot rule out virtual cameras, photographing a display or forged requests.

**Tech Stack:** Existing React/TypeScript, MediaDevices/canvas, Express, PostgreSQL, sharp and private disk storage. No new media dependency.

## Constraints

- Customer-facing text and tutorial diagrams are English; staff review stays in the existing Chinese UI.
- No microphone access; stop camera tracks when hidden, closed or unmounted.
- Preserve authorization, order reference binding, upload retry/cleanup, limits and existing claim allocations.
- Keep legacy claims readable; reject ordinary attachments on new damage submissions/supplements.
- HTTPS is required outside localhost. DNS/TLS activation for us-seel.com remains deferred by the user.
- No real customer submissions, email sends, payout calls or order mutations during testing.

## Implementation and checks

- [x] Backend: shared capture DTO, idempotent schema migration, ticket route, upload binding and damage submission validation. Test ticket expiry, cross-session use, reuse, retries, generic-file rejection, and manual-review exceptions in an isolated database.
- [x] UI: camera preview/retake/category controls, permission diagrams for iPhone Safari/Chrome and Android Chrome, exception form, matching supplemental workflow and staff evidence labels. Test state transitions and no accidental file picker.
- [x] Host: allow same-origin camera while keeping microphone disabled. Test the actual page response and host allowlist.
- [x] Integration: synthetic browser capture/upload/claim, permission denial/manual review, stream shutdown, desktop/mobile layout, and existing generic-upload regression.
- [x] Review and release: independent code review, build and relevant tests, versioned image with rollback, read-only production checks, and updated operations documentation.

## Primary references

- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- https://support.apple.com/guide/iphone/browse-the-web-privately-iphb01fc3c85/ios
- https://support.google.com/chrome/answer/2693767?co=GENIE.Platform%3DiOS&hl=en
- https://support.google.com/chrome/answer/2693767?co=GENIE.Platform%3DAndroid&hl=en

Permission menu labels vary by OS/browser version; the tutorial should explain equivalent controls rather than present an exact screenshot as universal.
