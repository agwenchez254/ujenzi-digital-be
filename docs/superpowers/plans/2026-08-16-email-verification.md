# Email Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the identity-squatting gap — email/password signups start unverified, `GET /users/lookup` excludes unverified accounts, and contractor/personnel invitation acceptance rejects an unverified caller. Login and general app use are unaffected.

**Architecture:** New `emailVerified`/`emailVerificationTokenHash`/`emailVerificationExpiresAt` columns on `User`, mirroring the existing password-reset fields exactly. A confirm/resend endpoint pair identical in shape to the password-reset pair. Enforcement added at exactly two points: `lookupByEmail` and the two invitation-acceptance methods.

**Tech Stack:** No new dependencies — reuses the existing `generateToken`/`hashToken` util and `MailService` dispatch pattern already established for password reset and email change.

## Global Constraints

- No automated tests, consistent with the rest of the project — manual curl/browser verification per task.
- Every account that exists before this migration runs is grandfathered as verified. Only email/password signups created after this ships start unverified; Google OAuth signups are always auto-verified.
- Login, viewing sites, requesting inspections, and every other existing capability are unaffected by verification status — only `GET /users/lookup` and the two invitation-acceptance endpoints enforce it.
- An unverified email in `lookup` must return the exact same `404` as a nonexistent one — never a distinguishable "found but unverified" response (that would leak registration status).
- Package manager is `pnpm` for `ujenzi-digital-be`, `npm` for `sitesight-pro`.

---

## File Structure

```
ujenzi-digital-be/
  prisma/schema.prisma                                (modify: 3 new User columns)
  prisma/migrations/<timestamp>_email_verification/   (create: generated + hand-edited backfill)
  src/mail/mail.service.ts                            (modify: add sendEmailVerification)
  src/auth/auth.service.ts                             (modify: signup/loginWithGoogle/confirm/resend)
  src/auth/auth.controller.ts                          (modify: 2 new routes)
  src/users/users.service.ts                           (modify: lookupByEmail filter)
  src/contractor-invitations/contractor-invitations.service.ts (modify: verified check in accept())
  src/personnel-invitations/personnel-invitations.service.ts   (modify: verified check in accept())

sitesight-pro/
  src/store/api/authApi.ts                            (modify: emailVerified field + 2 mutations)
  src/pages/VerifyEmail.tsx                            (create)
  src/App.tsx                                          (modify: add /verify-email route)
  src/components/layout/AppLayout.tsx                  (modify: verification banner)
```

---

### Task 1: Backend — data model

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_email_verification/` (generated, then hand-edited)

**Interfaces:**
- Produces: `User.emailVerified: boolean`, `User.emailVerificationTokenHash: string | null`, `User.emailVerificationExpiresAt: Date | null` on the generated Prisma client. Every later task depends on these.

- [ ] **Step 1: Add the fields to `schema.prisma`**

Add to the `User` model, alongside the existing password-reset fields:

```prisma
  passwordResetTokenHash String?
  passwordResetExpiresAt DateTime?
  emailVerified              Boolean   @default(false)
  emailVerificationTokenHash String?
  emailVerificationExpiresAt DateTime?
```

- [ ] **Step 2: Generate the migration without applying it yet**

```bash
pnpm prisma migrate dev --name email_verification --create-only
```

- [ ] **Step 3: Hand-edit the generated migration to backfill existing rows as verified**

Open the generated `prisma/migrations/<timestamp>_email_verification/migration.sql` and change the `emailVerified` column's default from the migration tool's usual immediate-final-default to a two-step default so existing rows backfill to `true` before the column's default flips to `false` for everything created afterward:

```sql
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerificationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "emailVerificationTokenHash" TEXT,
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT true;

-- Every row created from this point forward should start unverified; only
-- the backfill above (for rows that already existed) should default to true.
ALTER TABLE "User" ALTER COLUMN "emailVerified" SET DEFAULT false;
```

(If the generated file already has `DEFAULT false` on the `ADD COLUMN` line, change that occurrence to `DEFAULT true` and keep the trailing `ALTER COLUMN ... SET DEFAULT false` statement — the two must run in that order so existing rows pick up `true` from the column's default at the moment it's added, before the default changes for future inserts.)

- [ ] **Step 4: Apply the migration**

```bash
pnpm prisma migrate dev
```

- [ ] **Step 5: Verify the backfill**

```bash
docker exec $(docker ps --filter "publish=5433" -q) psql -U postgres -d ujenzi_digital -c "SELECT \"emailVerified\", count(*) FROM \"User\" GROUP BY \"emailVerified\";"
```

Expected: every existing row shows `emailVerified = true` (there should be no `false` rows yet, since no new signups have happened since the migration).

- [ ] **Step 6: Build**

```bash
pnpm run build
```

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add emailVerified to User, backfilling existing accounts as verified"
```

---

### Task 2: Backend — `MailService.sendEmailVerification`

**Files:**
- Modify: `src/mail/mail.service.ts`

**Interfaces:**
- Consumes: `this.frontendOrigin`, `this.dispatch` (existing private helpers, same file).
- Produces: `MailService.sendEmailVerification(email: EmailVerificationEmail): Promise<void>`. Task 3 calls this.

- [ ] **Step 1: Add the interface and method**

Modify `src/mail/mail.service.ts` — add near the other `*Email` interfaces:

```typescript
export interface EmailVerificationEmail {
  to: string;
  name: string;
  token: string;
}
```

Add the method, alongside `sendPasswordResetEmail`:

```typescript
  async sendEmailVerification(email: EmailVerificationEmail): Promise<void> {
    const link = `${this.frontendOrigin}/verify-email?token=${email.token}`;
    const subject = 'Verify your email address';
    const text =
      `Hi ${email.name},\n\n` +
      `Welcome to Ujenzi Digital. Click the link below to verify your email address ` +
      `(expires in 24 hours):\n${link}\n\n` +
      `If you didn't create this account, you can ignore this email.`;

    await this.dispatch(email.to, subject, text, undefined, link);
  }
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/mail/mail.service.ts
git commit -m "feat: add email verification mail template"
```

---

### Task 3: Backend — `AuthService` wiring

**Files:**
- Modify: `src/auth/auth.service.ts`

**Interfaces:**
- Consumes: `MailService.sendEmailVerification` (Task 2), `generateToken`/`hashToken` (existing util).
- Produces: `AuthService.confirmEmailVerification(token): Promise<void>`, `AuthService.resendEmailVerification(userId): Promise<void>`. Task 4's controller routes call these.

- [ ] **Step 1: Add the TTL constant**

Modify `src/auth/auth.service.ts`, alongside `PASSWORD_RESET_TTL_MS`:

```typescript
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 2: Send a verification email on email/password signup**

Modify `signup()`:

```typescript
  async signup(dto: SignupDto, res: Response, ip?: string): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const verificationToken = generateToken();

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name,
        phone: dto.phone,
        company: dto.company,
        certificationDetails: dto.certificationDetails,
        roles: { create: dto.roles.map((role) => ({ role })) },
        emailVerificationTokenHash: hashToken(verificationToken),
        emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      },
    });

    await this.auditLogService.log(
      user.id,
      'user.roles_assigned',
      'User',
      user.id,
      { roles: dto.roles },
      ip,
    );

    this.mailService
      .sendEmailVerification({ to: user.email, name: user.name, token: verificationToken })
      .catch((err) => console.error('Failed to send verification email', err));

    return this.issueTokens(user.id, res);
  }
```

- [ ] **Step 3: Auto-verify Google signups**

Modify `loginWithGoogle()` — both the new-user creation and the existing-account-linking branches:

```typescript
      user = existingByEmail
        ? await this.prisma.user.update({
            where: { id: existingByEmail.id },
            data: { googleId: profile.googleId, emailVerified: true },
          })
        : await this.prisma.user.create({
            data: {
              email: profile.email,
              googleId: profile.googleId,
              name: profile.name,
              avatarUrl: profile.avatarUrl,
              emailVerified: true,
            },
          });
```

- [ ] **Step 4: Add `confirmEmailVerification` and `resendEmailVerification`**

Add these methods, alongside `requestPasswordReset`/`resetPassword`:

```typescript
  async confirmEmailVerification(token: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { emailVerificationTokenHash: hashToken(token) },
    });
    if (!user) {
      throw new NotFoundException('Invalid or expired verification link');
    }
    if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt.getTime() < Date.now()) {
      throw new GoneException('This verification link has expired — request a new one');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerificationTokenHash: null, emailVerificationExpiresAt: null },
    });

    await this.auditLogService.log(user.id, 'user.email_verified', 'User', user.id, undefined, undefined);
  }

  async resendEmailVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerified) {
      return;
    }

    const token = generateToken();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerificationTokenHash: hashToken(token),
        emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      },
    });

    await this.mailService.sendEmailVerification({ to: user.email, name: user.name, token });
  }
```

- [ ] **Step 5: Build**

```bash
pnpm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/auth/auth.service.ts
git commit -m "feat: send verification email on signup, auto-verify Google signups, add confirm/resend"
```

---

### Task 4: Backend — `AuthController` routes

**Files:**
- Modify: `src/auth/auth.controller.ts`

**Interfaces:**
- Consumes: `AuthService.confirmEmailVerification`/`resendEmailVerification` (Task 3).
- Produces: `POST /auth/email-verification/confirm/:token`, `POST /auth/email-verification/resend`. Task 8 (frontend) calls these by path.

- [ ] **Step 1: Add the imports**

```typescript
import { Body, Controller, HttpCode, HttpStatus, Ip, Param, Post, Req, Res, UseGuards, Get } from '@nestjs/common';
```

- [ ] **Step 2: Add the routes**

Add after `resetPassword`:

```typescript
  @ApiOperation({ summary: 'Confirm an email address using the token emailed on signup' })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('email-verification/confirm/:token')
  async confirmEmailVerification(@Param('token') token: string) {
    await this.authService.confirmEmailVerification(token);
    return { success: true };
  }

  @ApiOperation({ summary: "Resend the caller's own email verification link" })
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('email-verification/resend')
  async resendEmailVerification(@CurrentUser() user: AuthenticatedUser) {
    await this.authService.resendEmailVerification(user.userId);
    return { success: true };
  }
```

- [ ] **Step 3: Build**

```bash
pnpm run build
```

- [ ] **Step 4: Manually verify the full signup → confirm flow**

```bash
pnpm run start:dev
```

```bash
SIGNUP=$(curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"verify-test@example.com","password":"password123","name":"Verify Test","roles":["contractor"]}')
echo "$SIGNUP" | grep -o '"emailVerified":[a-z]*'
```

Expected: `"emailVerified":false`. Grab the token from the dev server's `[dev mail]` log line (SMTP is unconfigured locally):

```bash
grep "verify-test@example.com" <path to your dev server's stdout/log> | tail -1
```

```bash
TOKEN="<paste the token from the link>"
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/auth/email-verification/confirm/$TOKEN

echo "--- expired/garbage token -> expect 404 ---"
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/auth/email-verification/confirm/garbage
```

Expected: first call `200 {"success":true}`; second `404`. Confirm in the DB that the row is now verified with cleared token fields:

```bash
docker exec $(docker ps --filter "publish=5433" -q) psql -U postgres -d ujenzi_digital -c \
  "SELECT \"emailVerified\", \"emailVerificationTokenHash\" FROM \"User\" WHERE email = 'verify-test@example.com';"
```

Expected: `emailVerified = t`, `emailVerificationTokenHash` is `NULL`. Leave `verify-test@example.com` in place — Task 5 reuses it as a *verified* control account; create a second, still-unverified signup for Task 5's actual test subject rather than cleaning this one up yet.

- [ ] **Step 5: Commit**

```bash
git add src/auth/auth.controller.ts
git commit -m "feat: add email verification confirm/resend endpoints"
```

---

### Task 5: Backend — enforce in `lookupByEmail`

**Files:**
- Modify: `src/users/users.service.ts`

**Interfaces:**
- Consumes: `User.emailVerified` (Task 1).
- Produces: nothing new consumed elsewhere — `lookupByEmail`'s existing callers (the `GET /users/lookup` route) get the narrowed behavior automatically.

- [ ] **Step 1: Filter by verified status**

Modify `src/users/users.service.ts`:

```typescript
  async lookupByEmail(email: string) {
    const user = await this.prisma.user.findFirst({
      where: { email, emailVerified: true },
      select: { id: true, name: true },
    });
    if (!user) {
      throw new NotFoundException('No user found with that email');
    }
    return user;
  }
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

- [ ] **Step 3: Manually verify**

```bash
UNVERIFIED_TOKEN=$(curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"unverified-lookup-test@example.com","password":"password123","name":"Unverified","roles":["contractor"]}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
VERIFIED_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"verify-test@example.com","password":"password123"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

echo "--- lookup the unverified account -> expect 404 ---"
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:3000/users/lookup?email=unverified-lookup-test@example.com" -H "Authorization: Bearer $VERIFIED_TOKEN"

echo "--- lookup the verified account -> expect 200 ---"
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:3000/users/lookup?email=verify-test@example.com" -H "Authorization: Bearer $VERIFIED_TOKEN"
```

Expected: first call `404`; second `200`. Stop the dev server; leave both test accounts in place for Task 6's verification.

- [ ] **Step 4: Commit**

```bash
git add src/users/users.service.ts
git commit -m "fix: exclude unverified accounts from GET /users/lookup"
```

---

### Task 6: Backend — enforce on invitation acceptance

**Files:**
- Modify: `src/contractor-invitations/contractor-invitations.service.ts`
- Modify: `src/personnel-invitations/personnel-invitations.service.ts`

**Interfaces:**
- Consumes: `User.emailVerified` (Task 1).
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Add the check to `ContractorInvitationsService.accept()`**

Modify `src/contractor-invitations/contractor-invitations.service.ts` — both branches need the caller's `emailVerified`, so widen the existing lookups' `select` and add the check right after the existing ownership check:

```typescript
    if (invitation.invitedUserId) {
      if (invitation.invitedUserId !== user.userId) {
        throw new ForbiddenException('This invitation was not sent to your account');
      }
      const caller = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.userId },
        select: { emailVerified: true },
      });
      if (!caller.emailVerified) {
        throw new ForbiddenException('Verify your email address before accepting this invitation');
      }
    } else {
      // Freeform invite — first account whose email matches claims it.
      const caller = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.userId },
        select: { email: true, emailVerified: true },
      });
      if (invitation.invitedEmail.toLowerCase() !== caller.email.toLowerCase()) {
        throw new ForbiddenException('This invitation was not sent to your account');
      }
      if (!caller.emailVerified) {
        throw new ForbiddenException('Verify your email address before accepting this invitation');
      }
    }
```

- [ ] **Step 2: Add the check to `PersonnelInvitationsService.accept()`**

Modify `src/personnel-invitations/personnel-invitations.service.ts`:

```typescript
    const caller = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { email: true, emailVerified: true },
    });
    if (!personnel.email || personnel.email.toLowerCase() !== caller.email.toLowerCase()) {
      throw new ForbiddenException('This invitation was not sent to your account');
    }
    if (!caller.emailVerified) {
      throw new ForbiddenException('Verify your email address before accepting this invitation');
    }
```

- [ ] **Step 3: Build**

```bash
pnpm run build
```

- [ ] **Step 4: Manually verify**

Reusing the unverified account from Task 5 (`unverified-lookup-test@example.com`), attempt to accept any pending contractor or personnel invitation as that account (create one first as a verified developer, targeting the unverified account's email or id, then attempt acceptance):

```bash
UNVERIFIED_TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"unverified-lookup-test@example.com","password":"password123"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
# <create a personnel invitation targeting this account's email as a separate verified developer/contractor, then:>
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/personnel-invitations/<token>/accept -H "Authorization: Bearer $UNVERIFIED_TOKEN"
```

Expected: `403` with the "Verify your email address" message. Then verify the account (via `/auth/email-verification/confirm/:token` as in Task 4) and confirm the same acceptance call now succeeds. Clean up all test accounts/sites/invitations created across Tasks 4-6.

- [ ] **Step 5: Commit**

```bash
git add src/contractor-invitations/contractor-invitations.service.ts src/personnel-invitations/personnel-invitations.service.ts
git commit -m "fix: require a verified email to accept a contractor/personnel invitation"
```

---

### Task 7: Frontend — `authApi.ts`

**Files:**
- Modify: `src/store/api/authApi.ts`

**Interfaces:**
- Consumes: the two new backend endpoints (Task 4).
- Produces: `AuthUser.emailVerified: boolean`, `useConfirmEmailVerificationMutation`, `useResendEmailVerificationMutation`. Tasks 8-9 depend on these.

- [ ] **Step 1: Add `emailVerified` to `AuthUser`**

Modify `src/store/api/authApi.ts`:

```typescript
export interface AuthUser {
  id: string;
  email: string;
  pendingEmail?: string | null;
  emailVerified: boolean;
  name: string;
  phone?: string | null;
  company?: string | null;
  certificationDetails?: string | null;
  avatarUrl?: string | null;
  status: string;
  googleId?: string | null;
  createdAt: string;
  updatedAt: string;
  roles: AppRole[];
}
```

- [ ] **Step 2: Add the two mutations**

Add alongside `resetPassword`:

```typescript
    confirmEmailVerification: builder.mutation<{ success: boolean }, string>({
      query: (token) => ({ url: `/auth/email-verification/confirm/${token}`, method: 'POST' }),
    }),
    resendEmailVerification: builder.mutation<{ success: boolean }, void>({
      query: () => ({ url: '/auth/email-verification/resend', method: 'POST' }),
    }),
```

Add to the export block:

```typescript
export const {
  useSignupMutation,
  useLoginMutation,
  useGetCsrfTokenQuery,
  useLazyGetCsrfTokenQuery,
  useRefreshMutation,
  useLogoutMutation,
  useRequestPasswordResetMutation,
  useResetPasswordMutation,
  useConfirmEmailVerificationMutation,
  useResendEmailVerificationMutation,
} = authApi;
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Commit**

```bash
git add src/store/api/authApi.ts
git commit -m "feat: add emailVerified field and verification mutations to authApi"
```

---

### Task 8: Frontend — `VerifyEmail.tsx`

**Files:**
- Create: `src/pages/VerifyEmail.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useConfirmEmailVerificationMutation` (Task 7).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Write `VerifyEmail.tsx`**

Matches `ResetPassword.tsx`'s exact structure/styling — a self-contained public page, not wrapped in `AppLayout`:

`src/pages/VerifyEmail.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, HardHat, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getApiErrorMessage } from '@/lib/apiError';
import { useConfirmEmailVerificationMutation } from '@/store/api/authApi';

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [confirmEmailVerification, { isLoading }] = useConfirmEmailVerificationMutation();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) return;
    confirmEmailVerification(token)
      .unwrap()
      .then(() => setSuccess(true))
      .catch((err) => setError(getApiErrorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-accent to-accent/80 mb-4 shadow-lg">
            <HardHat className="h-7 w-7 text-accent-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">SiteInspect</h1>
        </div>

        <Card className="border-0 shadow-2xl bg-card/80 backdrop-blur-xl">
          <CardHeader className="space-y-1 pb-6">
            <CardTitle className="text-2xl font-bold">Verify Email</CardTitle>
            <CardDescription className="text-base">
              {success ? "You're all set." : 'Confirming your email address...'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!token || error ? (
              <div className="text-center space-y-4 py-2">
                <XCircle className="h-10 w-10 text-destructive mx-auto" />
                <p className="text-foreground">
                  {error || 'This verification link is invalid.'}
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/auth">Back to Sign In</Link>
                </Button>
              </div>
            ) : success ? (
              <div className="text-center space-y-4 py-2">
                <CheckCircle2 className="h-10 w-10 text-success mx-auto" />
                <p className="text-foreground">Your email address has been verified.</p>
                <Button asChild className="w-full">
                  <Link to="/">Go to Dashboard</Link>
                </Button>
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-2">
                {isLoading ? 'Verifying...' : 'One moment...'}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the route**

Modify `src/App.tsx`:

```typescript
import VerifyEmail from "./pages/VerifyEmail";
```

```typescript
        {/* Public — reached via an emailed link while signed out, by definition. */}
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/VerifyEmail.tsx src/App.tsx
git commit -m "feat: add email verification confirmation page"
```

---

### Task 9: Frontend — verification banner

**Files:**
- Modify: `src/components/layout/AppLayout.tsx`

**Interfaces:**
- Consumes: `state.auth.user.emailVerified`, `useResendEmailVerificationMutation` (Task 7).
- Produces: nothing consumed elsewhere — last task.

- [ ] **Step 1: Add the banner**

Modify `src/components/layout/AppLayout.tsx` — add the import, read the user, add the resend handler, and render a second banner (stacked below the offline one, since both are independent conditions that could both be true at once):

```typescript
import { MailWarning, WifiOff } from 'lucide-react';
import { useResendEmailVerificationMutation } from '@/store/api/authApi';
```

```typescript
  const user = useAppSelector((state) => state.auth.user);
  const [resendVerification, { isLoading: resending }] = useResendEmailVerificationMutation();
  const [resent, setResent] = useState(false);

  const handleResendVerification = async () => {
    await resendVerification().unwrap();
    setResent(true);
  };
```

Add the second banner right after the offline one (so it stacks beneath rather than replacing it — note the offline banner uses `top-0`; give this one `top-7` to sit just below it when both show):

```tsx
      {user && !user.emailVerified && (
        <div className="fixed top-7 inset-x-0 z-[59] bg-accent text-accent-foreground text-xs font-medium text-center py-1.5 flex items-center justify-center gap-2">
          <MailWarning className="h-3 w-3 -mt-0.5" />
          <span>{resent ? 'Verification email sent — check your inbox.' : 'Please verify your email address.'}</span>
          {!resent && (
            <button
              type="button"
              onClick={handleResendVerification}
              disabled={resending}
              className="underline underline-offset-2 font-semibold"
            >
              Resend
            </button>
          )}
        </div>
      )}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 3: Manually verify**

Sign up a fresh account, confirm the verification banner appears immediately. Click Resend, confirm the "Verification email sent" message appears and a new `[dev mail]` log line shows up. Visit the link from that email, confirm the banner disappears afterward (on next page load / refetch of `state.auth.user`).

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/AppLayout.tsx
git commit -m "feat: show email verification reminder banner with resend action"
```

---

## Self-Review Notes

- **Spec coverage:** §2 data model — Task 1. §3 signup/login flow — Task 3. §4 endpoints — Task 4. §5 enforcement (lookup + both invitation accept methods) — Tasks 5-6. §6 frontend (page + banner) — Tasks 7-9.
- **Placeholder scan:** no TBDs; every step has literal code. Task 6 Step 4's verification instructions include a bracketed aside about creating a test invitation first — this is a genuine sequencing note (the exact invitation-creation curl commands were already established in Spec 4/4.5's plans and aren't repeated verbatim here to avoid this plan ballooning), not a placeholder for missing logic.
- **Type consistency:** `EmailVerificationEmail` (Task 2) matches its single call site in Task 3 exactly. `AuthUser.emailVerified` (Task 7) is populated automatically since `issueTokens()`'s `safeUser` spread (existing code, unchanged) already includes every column on the Prisma `User` row — adding the column in Task 1 is sufficient; no change to `issueTokens()` itself is needed. `useConfirmEmailVerificationMutation`/`useResendEmailVerificationMutation` (Task 7's exports) are the exact hook names Tasks 8-9 import.
