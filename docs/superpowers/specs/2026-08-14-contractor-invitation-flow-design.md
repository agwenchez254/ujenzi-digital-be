# Contractor Invitation Flow design

Date: 2026-08-14

## Purpose

Follows directly from a security review of Spec 4's developer-site-registration
work: when a developer registers a site and names an existing account as the
`CONTRACTOR` in `personnel`, that account was immediately made `Site.contractorId`
— gaining edit/delete rights over the site — without ever consenting to it. A
prior fix (`resolveContractorId`) closed the role-spoofing half of that finding
(the named account must actually hold the `contractor` role), but the
consent gap remained: a real contractor could still be assigned ownership of a
site they know nothing about. This spec closes that gap with an invitation:
the named contractor becomes the site's owner only after they accept, via a
time-limited activation link emailed to them, resendable by the inviting
developer if it expires unused.

## 1. Scope

Only the `CONTRACTOR` personnel link on **developer-created sites** goes
through invitation/consent. Contractor- and administrator-created sites are
unaffected (their `contractorId` is the creator or an admin-supplied id,
established at signup-time trust levels this flow doesn't need to touch).
Other personnel roles (`DEVELOPER`, `SITE_REPRESENTATIVE`,
`QUANTITY_SURVEYOR`, `ENGINEER`) are unaffected — they were never the subject
of the original finding, since none of them determine `contractorId`.
`PATCH /sites/:id` continues to never touch `contractorId` at all (unchanged
from Spec 4), so this flow only ever runs once, at creation.

## 2. Data model

New model, one row per site — a resend mutates this row in place rather than
creating a new one, so there is never more than one live invitation per site:

```prisma
model ContractorInvitation {
  id             String    @id @default(uuid())
  siteId         String    @unique
  invitedUserId  String
  invitedById    String
  tokenHash      String
  expiresAt      DateTime
  acceptedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  site      Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
  invited   User @relation("InvitedContractor", fields: [invitedUserId], references: [id])
  invitedBy User @relation("InvitingDeveloper", fields: [invitedById], references: [id])
}
```

Status is derived, never stored, mirroring how `RefreshToken.revokedAt`
already works in this codebase:

- `acceptedAt` set → **accepted** (terminal; accept/resend both reject further action)
- `acceptedAt` null, `expiresAt` in the future → **pending**
- `acceptedAt` null, `expiresAt` in the past → **expired** (resendable)

The token itself follows the exact `RefreshToken` pattern already in
`AuthService`: a random secret (`crypto.randomBytes(32).toString('hex')`) is
put in the email link; only its SHA-256 hash (`tokenHash`) is stored.
Lookups hash the incoming token and compare — the raw token is never
persisted, so a database read can't leak working invitation links.

## 3. Site creation changes

`resolveContractorId` (in `SitesService`) changes shape for the developer
path only. Today it returns the named contractor's `userId` directly, after
verifying they hold the `contractor` role. Instead, it returns the calling
**developer's own id** as the site's `contractorId`, plus a separate
`pendingContractorUserId` alongside it — `create()` uses the former to build
the site as before, and the latter (when present) to set up the invitation
after the site exists.

Sequence inside `create()`:

1. Transaction: create the `Site` (with `contractorId` = the developer),
   create the `SitePersonnel` rows (unchanged — the named contractor still
   shows up on the roster immediately, and still gets read access to the
   site via the existing `isTiedToSite` check; only their *ownership* is
   gated, not their visibility), and — when `pendingContractorUserId` is
   set — create the `ContractorInvitation` row in the same transaction.
2. After the transaction commits, if an invitation was created, send the
   email. A send failure is logged but does not roll back site creation or
   surface as an error to the developer — the invitation row still exists,
   and `resend` is the recovery path if the email never arrived.

Contractor- and administrator-created sites never populate
`pendingContractorUserId`, so this whole path is a no-op for them.

## 4. Endpoints

```
GET /contractor-invitations/:token
  Public (no auth — the token itself is the credential, matching how a
  password-reset link works). Hashes the token and looks up the row.
  404 if no match. Otherwise 200 with a minimal preview only:
    { siteName, invitedByName, status, expiresAt }
  Deliberately excludes site address/location/personnel — enough to render
  "You've been invited to be the contractor for X, invited by Y", nothing an
  unintended holder of the link could use for reconnaissance.

POST /contractor-invitations/:token/accept
  Requires auth. 404 if the token doesn't match any row. 403 if the
  authenticated caller's id isn't the invitation's invitedUserId (proves the
  logged-in account is the one actually invited, not just whoever has the
  link). 409 if already accepted. 410 Gone if expired (frontend then points
  them at "ask the developer to resend").
  On success, in a transaction: sets acceptedAt = now(), updates
  Site.contractorId to invitedUserId, audit-logs
  'site.contractor_invitation_accepted' against the site.

POST /sites/:id/contractor-invitation/resend
  Requires auth. Loads the site and its invitation (404 if neither exists).
  403 if the caller isn't currently Site.contractorId for that site (i.e.
  isn't the developer still sitting in the temporary-holder seat — once
  accepted, contractorId is the real contractor and resend no longer
  applies). 400 if the invitation is already accepted, or is still pending
  (not yet expired — resend exists for the expired case specifically, per
  the original ask; a developer who thinks the email was lost simply waits
  for it to expire, which at 48h is short enough not to need an
  early-resend path). On success: generates a new token, sets a fresh
  expiresAt (+48h from now), re-sends the email, audit-logs
  'site.contractor_invitation_resent'.
```

```
GET /sites/:id/contractor-invitation
  Requires auth. 403 unless the caller currently holds Site.contractorId for
  that site or is an administrator — the same authorization scope as
  resend. 404 if no invitation exists for the site. Otherwise 200 with
  { invitedUserName, invitedUserEmail, status, expiresAt }. This is the
  lookup SiteDetail.tsx's pending-invitation banner actually uses — unlike
  the first endpoint above, it's keyed by site id, not the raw token, since
  the developer viewing their own site never has the token (that was
  emailed to the invitee, not them).
```

All four live on a new `ContractorInvitationsController` (`/contractor-invitations` for
the token-based pair, nested under `SitesController`'s existing `:id` param for the
other two since they're scoped to a specific site).

## 5. Email delivery

New `MailModule`/`MailService`, using `nodemailer` over SMTP — no existing
email capability exists in this backend today. Config via env:
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. If
`SMTP_HOST` is unset, `MailService` logs the recipient/subject/link to the
console instead of sending, the same graceful-degradation pattern already
used for `web-push` when VAPID keys are absent — so local development and
this session's test flow keep working without real SMTP credentials.

The activation link is built as
`${FRONTEND_ORIGIN}/invitations/accept?token=<raw-token>`, reusing the
`FRONTEND_ORIGIN` env var that already exists for CORS. Email content is a
plain subject/body (HTML + text): "You've been invited as contractor for
{siteName}" with the link and a note that it expires in 48 hours. The same
template is reused for the initial send and for resends.

## 6. Frontend

New public page `InvitationAccept.tsx` at `/invitations/accept?token=...`.
Not wrapped in `ProtectedRoute` directly (the token, not a role, gates
access) — but if there's no active session it redirects to `/auth` with a
return-to param pointing back at itself, matching the redirect-back pattern
`ProtectedRoute` already uses elsewhere. Once authenticated, it calls the
preview endpoint, renders "You've been invited to be the contractor for
{site}, invited by {developer}", and shows an Accept button that calls the
accept endpoint. Expired/already-accepted states render a plain message
instead of the button.

`SiteDetail.tsx` gains a small pending-invitation banner, visible only to
the developer currently holding `contractorId` on a site with a pending or
expired invitation (fetched via a new `useGetContractorInvitationQuery`-style
call scoped to the site, added alongside the existing site query — returns
`null`/404 when there's no invitation, which the UI treats as "nothing to
show"). The banner shows the invited contractor's name/status; once expired,
a "Resend invitation" button appears and calls the resend endpoint.

## 7. Testing

No automated tests, consistent with the rest of the project. Backend:
curl-based checks that a developer's site is created with the developer as
`contractorId` immediately, that the invitation preview and accept endpoints
enforce the identity/status checks above, that accepting reassigns
`contractorId`, and that resend is rejected before expiry and succeeds after
(the 48h wait is impractical to test live — verified instead by manually
setting `expiresAt` into the past in the database before calling resend).
Frontend: browser verification that the accept page renders for a valid
token, redirects through login when logged out, and that the resend banner
appears on the site detail page once expired.
