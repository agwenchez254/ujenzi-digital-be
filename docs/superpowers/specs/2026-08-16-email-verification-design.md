# Email Verification design

Date: 2026-08-16

## Purpose

A background security audit found a critical gap: this app has no concept
of email verification anywhere. `signup()` creates a fully active account
from any self-reported email, no confirmation required. Concretely: an
attacker signs up as `contractor` using a real business's email address
they don't own. When a developer later calls `GET /users/lookup` while
adding site personnel, it returns the attacker's account — indistinguishable
from the real contractor. The developer links them as personnel or makes
them the site's actual `contractorId` owner via `resolveContractorId`
(which only checks the `contractor` role, not email ownership). The
attacker gets real edit/delete rights on the site, with zero interception
or token needed — just knowing the target's email address in advance.

This spec closes that gap by making email ownership something the app
actually verifies, and using that status at the two specific points where
an email address's trustworthiness matters: looking a person up to link
them, and accepting an invitation sent to their email.

## 1. Scope

Deliberately narrow, matching the actual exploit rather than a general
"you must verify to use the app" pattern:

- Unverified accounts can still log in and use the app normally — view
  sites, request inspections, everything. This isn't about gatekeeping
  general access.
- The only two places verification is actually enforced: `GET
  /users/lookup` (excludes unverified accounts from results) and
  contractor/personnel invitation **acceptance** (rejects an unverified
  account outright).
- Every account that exists before this ships is grandfathered in as
  verified — they've already been using the app; retroactively locking
  them out of `lookup`/invitations over a gap that didn't exist when they
  signed up would be a real disruption for no security benefit (the
  exploit is about *new* squatted accounts impersonating a real person's
  email going forward, not existing legitimate ones).
- Google OAuth signups are auto-verified — Google has already confirmed
  that address; making someone click an email link to re-confirm what
  Google already confirmed adds friction with no security benefit.

## 2. Data model

`User` gains three fields, matching the existing password-reset fields'
exact shape and naming convention:

```prisma
emailVerified              Boolean   @default(false)
emailVerificationTokenHash String?
emailVerificationExpiresAt DateTime?
```

The migration backfills every existing row to `emailVerified = true`
first (`ALTER TABLE ... ADD COLUMN ... DEFAULT true`, which fills existing
rows), then flips the column's default to `false` (`ALTER TABLE ... ALTER
COLUMN ... SET DEFAULT false`) so only rows created after this point start
unverified. The application always sets the field explicitly on creation
regardless (`false` for email/password signup, `true` for Google), so the
column-level default only matters for this one-time backfill correctness.

## 3. Signup / login flow

`AuthService.signup()` (email/password path) additionally: generates a
token, stores its hash + a 24-hour expiry, and emails it via a new
`MailService.sendEmailVerification({to, name, token})` — mirroring
`requestPasswordReset()`'s exact pattern (`generateToken`/`hashToken` from
the shared token util, same TTL-constant convention). The user is still
logged in and handed a working session immediately, per the scope above —
this is a background step, not a gate.

`AuthService.loginWithGoogle()` sets `emailVerified: true` directly on
both the brand-new-user and link-existing-account branches — no token,
no email.

## 4. New endpoints

```
POST /auth/email-verification/confirm/:token
  Public. Validates the token against its hash + expiry (identical
  control flow to POST /auth/reset-password), sets emailVerified = true,
  clears both token fields. 404 if no match, 410 Gone if expired.

POST /auth/email-verification/resend
  Requires auth — always resends for the caller's own account, never
  someone else's. Generates a fresh token/expiry, re-sends the email.
  Covered by the global rate-limit fix from the security audit pass —
  this endpoint has no bespoke throttling of its own to add.
```

## 5. Enforcement points

- `UsersService.lookupByEmail`: adds `emailVerified: true` to the Prisma
  `where` clause. An unverified account's email returns the exact same
  `404` as an email that isn't registered at all — deliberately
  indistinguishable, consistent with this app's existing pattern
  (`requestPasswordReset` already "behaves the same whether or not the
  email exists" to avoid leaking registration status). Returning a
  distinct "found but unverified" response was considered and rejected —
  it would trade the ownership-hijack hole for an email-enumeration one.
- `ContractorInvitationsService.accept()` / `PersonnelInvitationsService.accept()`:
  both load the accepting caller's own `User` row (already done today, to
  compare `caller.email` against the invitation's target email) and now
  additionally reject with a clear `ForbiddenException` if
  `emailVerified` is `false`, before the existing email-match check.

## 6. Frontend

New public page `VerifyEmail.tsx` at `/verify-email?token=...`, matching
the existing `ConfirmEmailChange`/`ResetPassword` pages' pattern exactly
(public route, calls the confirm endpoint, shows a success/expired
state). A compact persistent banner, styled like the existing offline
banner, appears for any logged-in user whose `user.emailVerified` is
`false`, with a "Resend verification email" action calling the resend
endpoint — `emailVerified` rides along on the same `user` object already
returned by login/signup (it's just a new column on the same Prisma
`User` row), so no additional fetch is needed to know whether to show it.

## 7. Testing

No automated tests, consistent with the rest of the project. Backend:
curl-based checks that a fresh email/password signup starts unverified
and is excluded from `/users/lookup` (returns 404 for its own email),
that confirming the emailed token flips it to verified and `lookup` then
finds it, that an expired/garbage token is rejected, that resend issues a
working new token, and that both invitation-acceptance endpoints reject
an unverified caller. Frontend: browser verification that the banner
appears for a freshly-signed-up (unverified) account and disappears after
visiting the verification link, and that resend actually delivers a new
usable link.
