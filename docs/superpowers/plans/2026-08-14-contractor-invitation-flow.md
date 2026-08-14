# Contractor Invitation Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a developer registers a site and names an existing account as `CONTRACTOR` in `personnel`, that account only becomes `Site.contractorId` after accepting a time-limited emailed invitation — closing the consent gap left after the earlier role-spoofing fix.

**Architecture:** A new `ContractorInvitation` model (one row per site, mutated in place on resend) tracked via a hashed token, mirroring the existing `RefreshToken` pattern. `SitesService.create()` sets `contractorId` to the developer temporarily and creates the invitation; a new `ContractorInvitationsModule` exposes preview/accept/status/resend endpoints; a new `MailModule` sends the emails (console fallback when SMTP isn't configured).

**Tech Stack:** NestJS 11, Prisma 6, `nodemailer` (new dependency) over SMTP. Frontend: RTK Query, existing `ProtectedRoute`/`Auth.tsx` redirect-back mechanism (fixed as part of this plan — it exists today but is unwired).

## Global Constraints

- Only the `CONTRACTOR` personnel link on **developer-created sites** goes through this flow. Contractor/administrator-created sites, and every other personnel role, are unaffected. `PATCH /sites/:id` still never touches `contractorId`.
- No automated tests, consistent with the rest of the project — manual curl/browser verification per task.
- Token storage follows `AuthService`'s existing `RefreshToken` convention exactly: only a SHA-256 hash is ever persisted; the raw token exists only in memory and the outgoing email.
- Package manager is `pnpm` for `ujenzi-digital-be`, `npm` for `sitesight-pro`.

---

## File Structure

```
ujenzi-digital-be/
  prisma/schema.prisma                                          (modify: ContractorInvitation model, User relations)
  prisma/migrations/<timestamp>_contractor_invitation/          (create: generated)
  src/common/utils/token.util.ts                                (create)
  src/mail/mail.module.ts                                       (create)
  src/mail/mail.service.ts                                      (create)
  src/sites/sites.service.ts                                    (modify: resolveContractorId, create())
  src/sites/sites.module.ts                                     (modify: import MailModule)
  src/contractor-invitations/contractor-invitations.module.ts   (create)
  src/contractor-invitations/contractor-invitations.service.ts  (create)
  src/contractor-invitations/contractor-invitations.controller.ts (create)
  src/app.module.ts                                             (modify: register MailModule, ContractorInvitationsModule)
  .env.example                                                  (modify: add SMTP_* vars)
  package.json                                                  (modify: add nodemailer, @types/nodemailer)

sitesight-pro/
  src/store/api/contractorInvitationsApi.ts                     (create)
  src/pages/Auth.tsx                                             (modify: honor location.state.from after login)
  src/pages/InvitationAccept.tsx                                 (create)
  src/App.tsx                                                    (modify: add /invitations/accept route)
  src/pages/SiteDetail.tsx                                       (modify: pending-invitation banner)
```

---

### Task 1: Backend — `ContractorInvitation` model

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_contractor_invitation/` (generated)

**Interfaces:**
- Produces: `prisma.contractorInvitation` client model with fields `{id, siteId, invitedUserId, invitedById, tokenHash, expiresAt, acceptedAt, createdAt, updatedAt}`. Tasks 4 and 5 depend on this.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

Add after the `PushSubscription` model:

```prisma
model ContractorInvitation {
  id            String    @id @default(uuid())
  siteId        String    @unique
  invitedUserId String
  invitedById   String
  tokenHash     String
  expiresAt     DateTime
  acceptedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  site      Site @relation(fields: [siteId], references: [id], onDelete: Cascade)
  invited   User @relation("InvitedContractor", fields: [invitedUserId], references: [id])
  invitedBy User @relation("InvitingDeveloper", fields: [invitedById], references: [id])

  @@index([invitedUserId])
}
```

- [ ] **Step 2: Add the back-relations to `Site` and `User`**

In `Site`, add alongside `personnel`:

```prisma
  personnel   SitePersonnel[]
  invitation  ContractorInvitation?
```

In `User`, add alongside `sitePersonnel`:

```prisma
  sitePersonnel        SitePersonnel[]
  pushSubscriptions    PushSubscription[]
  contractorInvitationsReceived ContractorInvitation[] @relation("InvitedContractor")
  contractorInvitationsSent     ContractorInvitation[] @relation("InvitingDeveloper")
```

- [ ] **Step 3: Generate and apply the migration**

```bash
pnpm prisma migrate dev --name contractor_invitation
```

If this hits the same `query_engine-windows.dll.node` EPERM error seen earlier in this session, identify and stop the stale `nest start --watch`/`dist/main` node processes (ask for confirmation before killing anything), then re-run `pnpm prisma generate`.

- [ ] **Step 4: Build and verify**

```bash
pnpm run build
docker exec $(docker ps --filter "publish=5433" -q) psql -U postgres -d ujenzi_digital -c "\d \"ContractorInvitation\""
```

Expected: build succeeds; table exists with the columns above and a unique constraint on `siteId`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add ContractorInvitation model"
```

---

### Task 2: Backend — shared token utility

**Files:**
- Create: `src/common/utils/token.util.ts`

**Interfaces:**
- Produces: `generateToken(): string`, `hashToken(token: string): string`. Tasks 4 and 5 both import these.

- [ ] **Step 1: Write the utility**

`src/common/utils/token.util.ts`:

```typescript
import { createHash, randomBytes } from 'crypto';

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/common/utils/token.util.ts
git commit -m "feat: add shared token generate/hash utility"
```

---

### Task 3: Backend — `MailModule`/`MailService`

**Files:**
- Create: `src/mail/mail.module.ts`
- Create: `src/mail/mail.service.ts`
- Modify: `.env.example`
- Modify: `package.json` (add `nodemailer`, `@types/nodemailer`)

**Interfaces:**
- Consumes: `ConfigService` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `FRONTEND_ORIGIN`).
- Produces: `MailService.sendContractorInvitation({to, contractorName, siteName, developerName, token, isResend}): Promise<void>`. Task 4 calls this; Task 5 calls it again for resend.

- [ ] **Step 1: Install nodemailer**

```bash
pnpm add nodemailer
pnpm add -D @types/nodemailer
```

- [ ] **Step 2: Write `MailService`**

`src/mail/mail.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface ContractorInvitationEmail {
  to: string;
  contractorName: string;
  siteName: string;
  developerName: string;
  token: string;
  isResend: boolean;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: this.configService.get<number>('SMTP_PORT') ?? 587,
        auth: {
          user: this.configService.get<string>('SMTP_USER'),
          pass: this.configService.get<string>('SMTP_PASS'),
        },
      });
    }
  }

  async sendContractorInvitation(email: ContractorInvitationEmail): Promise<void> {
    const link = `${this.configService.get<string>('FRONTEND_ORIGIN')}/invitations/accept?token=${email.token}`;
    const subject = email.isResend
      ? `Reminder: you've been invited as contractor for ${email.siteName}`
      : `You've been invited as contractor for ${email.siteName}`;
    const text =
      `Hi ${email.contractorName},\n\n` +
      `${email.developerName} has named you as the contractor for "${email.siteName}" on Ujenzi Digital.\n\n` +
      `Accept the invitation here (expires in 48 hours):\n${link}\n\n` +
      `If you weren't expecting this, you can ignore this email.`;

    if (!this.transporter) {
      this.logger.log(`[dev mail] To: ${email.to} | Subject: ${subject} | Link: ${link}`);
      return;
    }

    await this.transporter.sendMail({
      from: this.configService.get<string>('SMTP_FROM'),
      to: email.to,
      subject,
      text,
    });
  }
}
```

- [ ] **Step 3: Write `MailModule`**

`src/mail/mail.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
```

- [ ] **Step 4: Add SMTP env vars to `.env.example`**

Append to `.env.example`:

```
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@ujenzidigital.example
```

- [ ] **Step 5: Register in `app.module.ts`**

Add the import and to the `imports` array (alphabetically, next to `InspectionsModule`):

```typescript
import { MailModule } from './mail/mail.module';
```

```typescript
    InspectionsModule,
    MailModule,
    MediaModule,
```

- [ ] **Step 6: Build**

```bash
pnpm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/mail package.json pnpm-lock.yaml .env.example src/app.module.ts
git commit -m "feat: add MailModule with SMTP-backed contractor invitation email, console fallback in dev"
```

---

### Task 4: Backend — wire invitations into site creation

**Files:**
- Modify: `src/sites/sites.service.ts`
- Modify: `src/sites/sites.module.ts`

**Interfaces:**
- Consumes: `generateToken`/`hashToken` (Task 2), `MailService.sendContractorInvitation` (Task 3).
- Produces: developer-created sites now get `contractorId = developer` immediately, plus a `ContractorInvitation` row. Task 5's accept endpoint depends on this row shape.

- [ ] **Step 1: Import the new dependencies in `sites.service.ts`**

```typescript
import { generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
```

- [ ] **Step 2: Inject `MailService`**

```typescript
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private mailService: MailService,
  ) {}
```

- [ ] **Step 3: Add the invitation TTL constant**

Add near the top of the file, alongside `EARTH_RADIUS_METERS`:

```typescript
const CONTRACTOR_INVITATION_TTL_MS = 48 * 60 * 60 * 1000;
```

- [ ] **Step 4: Rewrite `resolveContractorId` to return pending-invite info**

Replace the method:

```typescript
  private async resolveContractorId(
    dto: CreateSiteDto,
    user: AuthenticatedUser,
  ): Promise<{ contractorId: string; pendingContractor?: { userId: string; email: string; name: string } }> {
    if (user.roles.includes('administrator')) {
      if (!dto.contractorId) {
        throw new ForbiddenException('contractorId is required when an administrator creates a site');
      }
      return { contractorId: dto.contractorId };
    }

    if (user.roles.includes('contractor')) {
      if (dto.contractorId && dto.contractorId !== user.userId) {
        throw new ForbiddenException('Cannot create a site for another contractor');
      }
      return { contractorId: user.userId };
    }

    const contractorEntry = dto.personnel?.find((p) => p.role === 'CONTRACTOR' && p.userId);
    if (!contractorEntry?.userId) {
      throw new BadRequestException(
        'A contractor must be assigned via personnel (with a linked account) when registering a site as a developer',
      );
    }
    const invitedUser = await this.prisma.user.findFirst({
      where: { id: contractorEntry.userId, roles: { some: { role: 'contractor' } } },
      select: { id: true, email: true, name: true },
    });
    if (!invitedUser) {
      throw new BadRequestException('The linked personnel account must have the contractor role');
    }

    // The developer holds contractorId temporarily until the invited contractor accepts.
    return {
      contractorId: user.userId,
      pendingContractor: { userId: invitedUser.id, email: invitedUser.email, name: invitedUser.name },
    };
  }
```

- [ ] **Step 5: Update `create()` to build the invitation and send the email**

Replace the whole method:

```typescript
  async create(dto: CreateSiteDto, user: AuthenticatedUser, ip?: string) {
    const { contractorId, pendingContractor } = await this.resolveContractorId(dto, user);
    const invitationToken = pendingContractor ? generateToken() : undefined;

    const created = await this.prisma.$transaction(async (tx) => {
      const site = await tx.site.create({
        data: {
          name: dto.name,
          contractorId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          geofenceRadius: dto.geofenceRadius,
          address: dto.address,
          constructionPhase: dto.constructionPhase,
          developmentType: dto.developmentType,
          country: dto.country,
          county: dto.county,
          constituency: dto.constituency,
          town: dto.town,
          plotNumber: dto.plotNumber,
          expectedEndDate: dto.expectedEndDate ? new Date(dto.expectedEndDate) : undefined,
          landmarks: dto.landmarks,
          approvals: dto.approvals as unknown as Prisma.InputJsonValue | undefined,
        },
      });

      if (dto.personnel?.length) {
        await tx.sitePersonnel.createMany({
          data: dto.personnel.map((p) => ({
            siteId: site.id,
            role: p.role,
            userId: p.userId,
            name: p.name,
            contact: p.contact,
          })),
        });
      }

      if (pendingContractor && invitationToken) {
        await tx.contractorInvitation.create({
          data: {
            siteId: site.id,
            invitedUserId: pendingContractor.userId,
            invitedById: user.userId,
            tokenHash: hashToken(invitationToken),
            expiresAt: new Date(Date.now() + CONTRACTOR_INVITATION_TTL_MS),
          },
        });
      }

      return site;
    });

    await this.auditLogService.log(user.userId, 'site.created', 'Site', created.id, { contractorId }, ip);

    if (pendingContractor && invitationToken) {
      await this.auditLogService.log(
        user.userId,
        'site.contractor_invited',
        'Site',
        created.id,
        { invitedUserId: pendingContractor.userId },
        ip,
      );
      const developer = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } });
      this.mailService
        .sendContractorInvitation({
          to: pendingContractor.email,
          contractorName: pendingContractor.name,
          siteName: dto.name,
          developerName: developer?.name ?? 'A developer',
          token: invitationToken,
          isResend: false,
        })
        .catch((err) => {
          // Site creation already succeeded; a failed send is recovered via the resend endpoint.
          console.error('Failed to send contractor invitation email', err);
        });
    }

    return this.findSiteOrThrow(created.id);
  }
```

- [ ] **Step 6: Import `MailModule` in `sites.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MailModule } from '../mail/mail.module';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

@Module({
  imports: [AuditLogModule, MailModule],
  controllers: [SitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
```

- [ ] **Step 7: Build**

```bash
pnpm run build
```

- [ ] **Step 8: Manually verify a developer site creation now defers ownership**

```bash
pnpm run start:dev
```

```bash
DEVELOPER_TOKEN=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"inv-dev@example.com","password":"password123","name":"Inv Dev","roles":["developer"]}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
DEVELOPER_ID=$(curl -s http://localhost:5000/users/me -H "Authorization: Bearer $DEVELOPER_TOKEN" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

CONTRACTOR_SIGNUP=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"inv-contractor@example.com","password":"password123","name":"Inv Contractor","roles":["contractor"]}')
CONTRACTOR_ID=$(echo "$CONTRACTOR_SIGNUP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s -X POST http://localhost:5000/sites -H "Authorization: Bearer $DEVELOPER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Invite Test Site\",\"latitude\":-1.28,\"longitude\":36.81,\"address\":\"1 Invite Way\",\"personnel\":[{\"role\":\"CONTRACTOR\",\"userId\":\"$CONTRACTOR_ID\"}]}"
```

Expected: `201`, and the response's `contractorId` equals `$DEVELOPER_ID`, **not** `$CONTRACTOR_ID`. Check the dev server log for the `[dev mail]` line containing the activation link (SMTP is unconfigured in this environment, so it logs instead of sending).

```bash
docker exec $(docker ps --filter "publish=5433" -q) psql -U postgres -d ujenzi_digital -c "SELECT \"siteId\", \"invitedUserId\", \"invitedById\", \"expiresAt\", \"acceptedAt\" FROM \"ContractorInvitation\";"
```

Expected: one row, `invitedUserId` = `$CONTRACTOR_ID`, `invitedById` = `$DEVELOPER_ID`, `acceptedAt` null. Keep this site/invitation around — Task 5's verification reuses it. Stop the dev server for now.

- [ ] **Step 9: Commit**

```bash
git add src/sites/sites.service.ts src/sites/sites.module.ts
git commit -m "feat: defer developer-registered site's contractorId until the named contractor accepts an invitation"
```

---

### Task 5: Backend — `ContractorInvitationsModule`

**Files:**
- Create: `src/contractor-invitations/contractor-invitations.service.ts`
- Create: `src/contractor-invitations/contractor-invitations.controller.ts`
- Create: `src/contractor-invitations/contractor-invitations.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `generateToken`/`hashToken` (Task 2), `MailService` (Task 3), the `ContractorInvitation` row created in Task 4.
- Produces: the four endpoints described in the design doc. Task 6 (frontend) consumes these by exact path/shape.

- [ ] **Step 1: Write `ContractorInvitationsService`**

`src/contractor-invitations/contractor-invitations.service.ts`:

```typescript
import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const CONTRACTOR_INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

function invitationStatus(invitation: { acceptedAt: Date | null; expiresAt: Date }): 'accepted' | 'expired' | 'pending' {
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.expiresAt.getTime() < Date.now()) return 'expired';
  return 'pending';
}

@Injectable()
export class ContractorInvitationsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private mailService: MailService,
  ) {}

  async previewByToken(token: string) {
    const invitation = await this.findByToken(token);
    return {
      siteName: invitation.site.name,
      invitedByName: invitation.invitedBy.name,
      status: invitationStatus(invitation),
      expiresAt: invitation.expiresAt,
    };
  }

  async accept(token: string, user: AuthenticatedUser, ip?: string) {
    const invitation = await this.findByToken(token);

    if (invitation.invitedUserId !== user.userId) {
      throw new ForbiddenException('This invitation was not sent to your account');
    }
    if (invitation.acceptedAt) {
      throw new ConflictException('This invitation has already been accepted');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new GoneException('This invitation has expired — ask the site owner to resend it');
    }

    await this.prisma.$transaction([
      this.prisma.contractorInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      }),
      this.prisma.site.update({
        where: { id: invitation.siteId },
        data: { contractorId: invitation.invitedUserId },
      }),
    ]);

    await this.auditLogService.log(
      user.userId,
      'site.contractor_invitation_accepted',
      'Site',
      invitation.siteId,
      undefined,
      ip,
    );
  }

  async getForSite(siteId: string, user: AuthenticatedUser) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { contractorId: true } });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    this.assertCanManage(site, user);

    const invitation = await this.prisma.contractorInvitation.findUnique({
      where: { siteId },
      include: { invited: { select: { name: true, email: true } } },
    });
    if (!invitation) {
      throw new NotFoundException('No invitation exists for this site');
    }

    return {
      invitedUserName: invitation.invited.name,
      invitedUserEmail: invitation.invited.email,
      status: invitationStatus(invitation),
      expiresAt: invitation.expiresAt,
    };
  }

  async resend(siteId: string, user: AuthenticatedUser, ip?: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { contractorId: true, name: true },
    });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    this.assertCanManage(site, user);

    const invitation = await this.prisma.contractorInvitation.findUnique({
      where: { siteId },
      include: { invited: { select: { name: true, email: true } } },
    });
    if (!invitation) {
      throw new NotFoundException('No invitation exists for this site');
    }
    if (invitation.acceptedAt) {
      throw new ConflictException('This invitation has already been accepted');
    }
    if (invitation.expiresAt.getTime() >= Date.now()) {
      throw new BadRequestException('This invitation has not expired yet');
    }

    const token = generateToken();
    await this.prisma.contractorInvitation.update({
      where: { id: invitation.id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + CONTRACTOR_INVITATION_TTL_MS) },
    });

    await this.auditLogService.log(user.userId, 'site.contractor_invitation_resent', 'Site', siteId, undefined, ip);

    await this.mailService.sendContractorInvitation({
      to: invitation.invited.email,
      contractorName: invitation.invited.name,
      siteName: site.name,
      developerName: user.userId === invitation.invitedById ? 'You' : 'The site owner',
      token,
      isResend: true,
    });
  }

  private assertCanManage(site: { contractorId: string }, user: AuthenticatedUser) {
    if (site.contractorId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException('You do not manage this site\'s contractor invitation');
    }
  }

  private async findByToken(token: string) {
    const invitation = await this.prisma.contractorInvitation.findFirst({
      where: { tokenHash: hashToken(token) },
      include: { site: { select: { name: true } }, invitedBy: { select: { name: true } } },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    return invitation;
  }
}
```

- [ ] **Step 2: Write `ContractorInvitationsController`**

`src/contractor-invitations/contractor-invitations.controller.ts`:

```typescript
import { Controller, Get, Ip, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ContractorInvitationsService } from './contractor-invitations.service';

@ApiTags('Contractor Invitations')
@Controller()
export class ContractorInvitationsController {
  constructor(private contractorInvitationsService: ContractorInvitationsService) {}

  @ApiOperation({ summary: 'Preview a contractor invitation by its emailed token (no auth required)' })
  @Public()
  @Get('contractor-invitations/:token')
  preview(@Param('token') token: string) {
    return this.contractorInvitationsService.previewByToken(token);
  }

  @ApiOperation({ summary: 'Accept a contractor invitation (must be logged in as the invited account)' })
  @ApiBearerAuth()
  @Post('contractor-invitations/:token/accept')
  accept(@Param('token') token: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.contractorInvitationsService.accept(token, user, ip);
  }

  @ApiOperation({ summary: "Get a site's pending contractor invitation status (current contractorId holder or admin only)" })
  @ApiBearerAuth()
  @Get('sites/:id/contractor-invitation')
  getForSite(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contractorInvitationsService.getForSite(id, user);
  }

  @ApiOperation({ summary: 'Resend an expired contractor invitation (current contractorId holder or admin only)' })
  @ApiBearerAuth()
  @Post('sites/:id/contractor-invitation/resend')
  resend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.contractorInvitationsService.resend(id, user, ip);
  }
}
```

- [ ] **Step 3: Write `ContractorInvitationsModule`**

`src/contractor-invitations/contractor-invitations.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MailModule } from '../mail/mail.module';
import { ContractorInvitationsController } from './contractor-invitations.controller';
import { ContractorInvitationsService } from './contractor-invitations.service';

@Module({
  imports: [AuditLogModule, MailModule],
  controllers: [ContractorInvitationsController],
  providers: [ContractorInvitationsService],
})
export class ContractorInvitationsModule {}
```

- [ ] **Step 4: Register in `app.module.ts`**

```typescript
import { ContractorInvitationsModule } from './contractor-invitations/contractor-invitations.module';
```

```typescript
    AuthModule,
    ContractorInvitationsModule,
    InspectionRequestsModule,
```

- [ ] **Step 5: Build**

```bash
pnpm run build
```

- [ ] **Step 6: Manually verify the full accept flow**

Reuses the site/invitation/tokens from Task 4 Step 8 — restart the dev server (the in-memory `invitationToken` from that curl session is gone, but the DB row remains, so grab the raw token from the dev server's console log at the time it was created; if that log is no longer visible, resend isn't usable yet since it hasn't expired — instead delete and recreate the invitation via a fresh `POST /sites` call as in Task 4 Step 8, and copy the token from this run's log immediately).

```bash
pnpm run start:dev
```

```bash
# From the fresh POST /sites response above, copy the token out of the "[dev mail] ... Link: ...?token=<TOKEN>" log line.
TOKEN="<paste from log>"

echo "--- preview (no auth) ---"
curl -s -w "\nHTTP %{http_code}\n" http://localhost:5000/contractor-invitations/$TOKEN

echo "--- accept as the wrong user -> expect 403 ---"
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:5000/contractor-invitations/$TOKEN/accept -H "Authorization: Bearer $DEVELOPER_TOKEN"

echo "--- accept as the invited contractor -> expect 200 ---"
CONTRACTOR_TOKEN=$(curl -s -X POST http://localhost:5000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"inv-contractor@example.com","password":"password123"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:5000/contractor-invitations/$TOKEN/accept -H "Authorization: Bearer $CONTRACTOR_TOKEN"

echo "--- confirm the site's contractorId is now the contractor ---"
curl -s http://localhost:5000/sites/$SITE_ID -H "Authorization: Bearer $CONTRACTOR_TOKEN" | grep -o '"contractorId":"[^"]*"'
```

Expected: preview 200 with `status: "pending"`; wrong-user accept 403; correct accept 200; site's `contractorId` now equals the contractor's id.

```bash
echo "--- resend before expiry -> expect 400 ---"
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:5000/sites/$SITE_ID/contractor-invitation/resend -H "Authorization: Bearer $DEVELOPER_TOKEN"
```

Expected: `400` — either "already accepted" (if using the same invitation from the accept test above) or "has not expired yet" if testing a separate still-pending one. To specifically verify the expired→resend path, create one more site the same way, then manually expire it:

```bash
docker exec $(docker ps --filter "publish=5433" -q) psql -U postgres -d ujenzi_digital -c \
  "UPDATE \"ContractorInvitation\" SET \"expiresAt\" = now() - interval '1 hour' WHERE \"siteId\" = '<new-site-id>';"

curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:5000/sites/<new-site-id>/contractor-invitation/resend -H "Authorization: Bearer $DEVELOPER_TOKEN"
```

Expected: `200`, and a fresh `[dev mail]` log line with a new token and a new 48h expiry. Stop the dev server and clean up all test users/sites/invitations created in Tasks 4–5.

```bash
docker exec $(docker ps --filter "publish=5433" -q) psql -U postgres -d ujenzi_digital -c "
DELETE FROM \"ContractorInvitation\" WHERE \"invitedById\" IN (SELECT id FROM \"User\" WHERE email = 'inv-dev@example.com');
DELETE FROM \"SitePersonnel\" WHERE \"siteId\" IN (SELECT id FROM \"Site\" WHERE \"contractorId\" IN (SELECT id FROM \"User\" WHERE email IN ('inv-dev@example.com','inv-contractor@example.com')));
DELETE FROM \"Site\" WHERE \"contractorId\" IN (SELECT id FROM \"User\" WHERE email IN ('inv-dev@example.com','inv-contractor@example.com'));
DELETE FROM \"UserRole\" WHERE \"userId\" IN (SELECT id FROM \"User\" WHERE email IN ('inv-dev@example.com','inv-contractor@example.com'));
DELETE FROM \"User\" WHERE email IN ('inv-dev@example.com','inv-contractor@example.com');
"
```

- [ ] **Step 7: Commit**

```bash
git add src/contractor-invitations src/app.module.ts
git commit -m "feat: add contractor invitation preview/accept/status/resend endpoints"
```

---

### Task 6: Frontend — `contractorInvitationsApi.ts`

**Files:**
- Create: `src/store/api/contractorInvitationsApi.ts`

**Interfaces:**
- Consumes: the four endpoints from Task 5.
- Produces: `useGetInvitationPreviewQuery`, `useAcceptInvitationMutation`, `useGetSiteContractorInvitationQuery`, `useResendContractorInvitationMutation`. Tasks 8 and 9 use these.

- [ ] **Step 1: Write the API slice**

`src/store/api/contractorInvitationsApi.ts`:

```typescript
import { baseApi } from './baseApi';

export type ContractorInvitationStatus = 'pending' | 'accepted' | 'expired';

export interface InvitationPreview {
  siteName: string;
  invitedByName: string;
  status: ContractorInvitationStatus;
  expiresAt: string;
}

export interface SiteContractorInvitation {
  invitedUserName: string;
  invitedUserEmail: string;
  status: ContractorInvitationStatus;
  expiresAt: string;
}

export const contractorInvitationsApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getInvitationPreview: builder.query<InvitationPreview, string>({
      query: (token) => `/contractor-invitations/${token}`,
    }),
    acceptInvitation: builder.mutation<void, string>({
      query: (token) => ({ url: `/contractor-invitations/${token}/accept`, method: 'POST' }),
      invalidatesTags: (_result, _error, _token) => [{ type: 'Site' as const, id: 'LIST' }],
    }),
    getSiteContractorInvitation: builder.query<SiteContractorInvitation, string>({
      query: (siteId) => `/sites/${siteId}/contractor-invitation`,
    }),
    resendContractorInvitation: builder.mutation<void, string>({
      query: (siteId) => ({ url: `/sites/${siteId}/contractor-invitation/resend`, method: 'POST' }),
      invalidatesTags: (_result, _error, siteId) => [{ type: 'Site' as const, id: siteId }],
    }),
  }),
});

export const {
  useGetInvitationPreviewQuery,
  useAcceptInvitationMutation,
  useGetSiteContractorInvitationQuery,
  useResendContractorInvitationMutation,
} = contractorInvitationsApi;
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 3: Commit**

```bash
git add src/store/api/contractorInvitationsApi.ts
git commit -m "feat: add contractor invitations RTK Query API slice"
```

---

### Task 7: Frontend — fix `Auth.tsx` redirect-back

**Files:**
- Modify: `src/pages/Auth.tsx`

**Interfaces:**
- Consumes: `location.state.from`, already passed by the existing `ProtectedRoute` on redirect (`src/components/auth/ProtectedRoute.tsx:18`) but currently unused.
- Produces: nothing new consumed elsewhere — this makes an existing mechanism actually work. Task 8's login-then-return-to-the-invitation flow depends on this.

- [ ] **Step 1: Read the redirect target from location state**

Modify `src/pages/Auth.tsx`:

```typescript
import { useNavigate, useLocation } from 'react-router-dom';
```

```typescript
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location } | null)?.from;
```

- [ ] **Step 2: Navigate to it after login/signup**

```typescript
      if (isSignUp) {
        await signup({ email, password, name, phone, company, roles: [role] }).unwrap();
      } else {
        await login({ email, password }).unwrap();
      }
      navigate(from ?? '/');
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Manually verify**

Start both dev servers. While logged out, visit `/sites` directly (any protected route) — confirm you're bounced to `/auth`. Log in — confirm you land back on `/sites`, not `/`. This is the same mechanism `/invitations/accept?token=...` will rely on in Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Auth.tsx
git commit -m "fix: return to the originally-requested page after login instead of always landing on /"
```

---

### Task 8: Frontend — `InvitationAccept.tsx`

**Files:**
- Create: `src/pages/InvitationAccept.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useGetInvitationPreviewQuery`/`useAcceptInvitationMutation` (Task 6), `ProtectedRoute` (existing, now correctly returns here after login per Task 7).
- Produces: nothing consumed elsewhere — a leaf page.

- [ ] **Step 1: Write `InvitationAccept.tsx`**

`src/pages/InvitationAccept.tsx`:

```tsx
import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { getApiErrorMessage } from '@/lib/apiError';
import {
  useGetInvitationPreviewQuery,
  useAcceptInvitationMutation,
} from '@/store/api/contractorInvitationsApi';

export default function InvitationAccept() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { toast } = useToast();
  const { data: preview, isLoading, error } = useGetInvitationPreviewQuery(token, { skip: !token });
  const [acceptInvitation, { isLoading: accepting }] = useAcceptInvitationMutation();

  const handleAccept = async () => {
    try {
      await acceptInvitation(token).unwrap();
      toast({ title: 'Invitation accepted', description: "You're now the contractor for this site." });
    } catch (err) {
      toast({ title: 'Error', description: getApiErrorMessage(err), variant: 'destructive' });
    }
  };

  return (
    <AppLayout>
      <PageHeader title="Contractor Invitation" />
      <div className="p-4 max-w-md mx-auto animate-fade-in">
        <Card>
          <CardContent className="p-6 text-center space-y-4">
            {!token || error ? (
              <>
                <XCircle className="h-10 w-10 text-destructive mx-auto" />
                <p className="text-foreground">This invitation link is invalid.</p>
              </>
            ) : isLoading ? (
              <p className="text-muted-foreground">Loading invitation...</p>
            ) : preview?.status === 'accepted' ? (
              <>
                <CheckCircle2 className="h-10 w-10 text-success mx-auto" />
                <p className="text-foreground">This invitation has already been accepted.</p>
              </>
            ) : preview?.status === 'expired' ? (
              <>
                <Clock className="h-10 w-10 text-muted-foreground mx-auto" />
                <p className="text-foreground">
                  This invitation has expired. Ask {preview.invitedByName} to resend it.
                </p>
              </>
            ) : preview ? (
              <>
                <p className="text-foreground">
                  <span className="font-semibold">{preview.invitedByName}</span> has invited you to be the
                  contractor for <span className="font-semibold">{preview.siteName}</span>.
                </p>
                <Button onClick={handleAccept} disabled={accepting} className="w-full">
                  Accept Invitation
                </Button>
              </>
            ) : null}
            <Button asChild variant="ghost" className="w-full">
              <Link to="/">Back to Dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Add the route**

Modify `src/App.tsx`:

```typescript
import InvitationAccept from "./pages/InvitationAccept";
```

Add alongside the other `ProtectedRoute`-wrapped routes:

```typescript
        <Route
          path="/invitations/accept"
          element={
            <ProtectedRoute>
              <InvitationAccept />
            </ProtectedRoute>
          }
        />
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Manually verify**

Using a token from a fresh backend invitation (Task 5's manual verification produces one), visit `/invitations/accept?token=<token>` while logged out as the invited contractor — confirm redirect to `/auth`, then after logging in, landing back on the invitation page with the preview rendered, and that clicking Accept succeeds and the site's `contractorId` updates.

- [ ] **Step 5: Commit**

```bash
git add src/pages/InvitationAccept.tsx src/App.tsx
git commit -m "feat: add contractor invitation accept page"
```

---

### Task 9: Frontend — pending-invitation banner on `SiteDetail.tsx`

**Files:**
- Modify: `src/pages/SiteDetail.tsx`

**Interfaces:**
- Consumes: `useGetSiteContractorInvitationQuery`/`useResendContractorInvitationMutation` (Task 6).
- Produces: nothing consumed elsewhere — last task.

- [ ] **Step 1: Add the query and resend handler**

Modify `src/pages/SiteDetail.tsx` — add the import and, inside the component, the query/mutation:

```typescript
import { Mail } from 'lucide-react';
import {
  useGetSiteContractorInvitationQuery,
  useResendContractorInvitationMutation,
} from '@/store/api/contractorInvitationsApi';
```

```typescript
  const { data: invitation } = useGetSiteContractorInvitationQuery(id ?? '', {
    skip: !id || currentSite?.contractor_id !== user?.id,
  });
  const [resendInvitation, { isLoading: resending }] = useResendContractorInvitationMutation();

  const handleResend = async () => {
    if (!id) return;
    try {
      await resendInvitation(id).unwrap();
      toast({ title: 'Invitation resent', description: 'A new link has been emailed to the contractor.' });
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to resend invitation.', variant: 'destructive' });
    }
  };
```

The `skip` condition matters: the endpoint 403s for anyone but the current `contractorId` holder, so only query it when the viewer is that holder (which, while an invitation is pending, is the developer — not the eventual contractor).

- [ ] **Step 2: Render the banner**

Add right after the "Status & Phase" block, before "Main Details":

```tsx
        {invitation && invitation.status !== 'accepted' && (
          <Card className="border-warning/40 bg-warning/5">
            <CardContent className="p-4 flex items-start gap-3">
              <Mail className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  Invitation {invitation.status} — {invitation.invitedUserName} ({invitation.invitedUserEmail})
                </p>
                <p className="text-xs text-muted-foreground">
                  You remain the contractor of record until they accept.
                </p>
              </div>
              {invitation.status === 'expired' && (
                <Button size="sm" variant="outline" onClick={handleResend} disabled={resending}>
                  Resend
                </Button>
              )}
            </CardContent>
          </Card>
        )}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

Confirmed: `warning` is a defined Tailwind token in this project (`tailwind.config.ts`), so `border-warning/40`, `bg-warning/5`, and `text-warning` all resolve as written above.

- [ ] **Step 4: Manually verify**

As the developer who created a pending-invitation site (from Task 5/8's manual testing), open its detail page — confirm the banner renders with "pending" status and no Resend button. Manually expire the invitation in the database (as in Task 5 Step 6) and refetch — confirm the Resend button appears and works.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SiteDetail.tsx
git commit -m "feat: show pending contractor invitation status and resend action on site detail"
```

---

## Self-Review Notes

- **Spec coverage:** §2 data model — Task 1. §3 site creation changes — Task 4. §4 all four endpoints — Task 5. §5 email delivery — Task 3. §6 frontend (accept page + banner) — Tasks 6, 8, 9, plus the Task 7 fix the design's redirect-back assumption actually required (found during file-gathering: `Auth.tsx` ignores `location.state.from` today, so the design's assumed mechanism needed a real fix, not just reuse).
- **Placeholder scan:** no TBDs; every step has literal code. Confirmed the `warning` Tailwind token Task 9 uses actually exists in `tailwind.config.ts` before finalizing that step.
- **Type consistency:** `ContractorInvitationStatus`/`InvitationPreview`/`SiteContractorInvitation` (Task 6) match the exact response shapes defined in Task 5's service methods. `resolveContractorId`'s new return type (Task 4) is consumed immediately in the same task's `create()` rewrite — no other caller exists. `MailService.sendContractorInvitation`'s parameter shape (Task 3) matches both call sites (Task 4's `create()` and Task 5's `resend()`) exactly, including `isResend`.
