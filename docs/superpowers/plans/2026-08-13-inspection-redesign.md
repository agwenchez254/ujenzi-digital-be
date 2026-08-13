# Inspection Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed inspection checklist with a Tiptap rich-text notes field, close the site-tie authorization gaps in Inspections/Media/InspectionRequests found during design, and fix the frontend's stale developer-as-admin permission mapping.

**Architecture:** A new `SitesService.isTiedToSite`/`resolveTiedSiteIds` pair becomes the one shared authorization primitive that `InspectionsService`, `MediaService`, and `InspectionRequestsService` all call — no logic duplicated across the three. Read access broadens to anyone tied to a site; write access (starting/updating/submitting an inspection, uploading/deleting media) stays exactly as restrictive as it is today (assigned engineer or administrator only).

**Tech Stack:** NestJS 11, Prisma 6 (plain column drop/add, no raw SQL). Frontend: `@tiptap/react` + `@tiptap/pm` + `@tiptap/starter-kit` (new), existing RTK Query patterns.

## Global Constraints

- No automated tests in this pass, consistent with the rest of the project. Every task substitutes a manual verification step.
- Write access to an `Inspection` (`update`/`submit`) and to `Media` (`upload`/`remove`) stays restricted to the assigned engineer or administrator — unchanged from today. Only **read** access (`GET /inspections`, `GET /inspections/:id`, `GET /inspections/:id/media`, `GET /media/:id/file`) broadens to any user tied to the inspection's site.
- `contractorId` on `InspectionRequest` is always derived from `site.contractorId` server-side — no DTO ever accepts it as client input again.
- The parallel `RolePermission`/JWT-`permissions` system is not touched or integrated with anywhere in this plan — it's decorative (no guard reads it yet).
- Package manager is `pnpm` for `ujenzi-digital-be`, `npm` for `sitesight-pro`.

---

## File Structure

```
ujenzi-digital-be/
  prisma/schema.prisma                                          (modify: Inspection.notes -> Json, drop 3 columns)
  prisma/migrations/<timestamp>_inspection_notes_json/          (create: generated)
  src/inspections/dto/checklist-response-item.dto.ts            (delete)
  src/inspections/dto/update-inspection.dto.ts                  (modify)
  src/inspections/inspections.service.ts                        (modify)
  src/inspections/inspections.controller.ts                     (modify)
  src/sites/sites.service.ts                                    (modify: add isTiedToSite/resolveTiedSiteIds)
  src/inspection-requests/dto/create-inspection-request.dto.ts  (modify: drop contractorId)
  src/inspection-requests/dto/update-inspection-request.dto.ts  (modify)
  src/inspection-requests/inspection-requests.module.ts         (modify: import SitesModule)
  src/inspection-requests/inspection-requests.service.ts         (modify)
  src/inspection-requests/inspection-requests.controller.ts      (modify)
  src/media/media.module.ts                                      (modify: import SitesModule)
  src/media/media.service.ts                                     (modify)
  src/media/media.controller.ts                                  (modify)

sitesight-pro/
  package.json                                                   (modify: add tiptap deps)
  src/hooks/usePermissions.ts                                     (modify)
  src/components/dashboard/QuickActions.tsx                       (modify)
  src/store/api/inspectionsApi.ts                                 (modify)
  src/pages/InspectionForm.tsx                                    (modify: rewrite)
```

---

### Task 1: Prisma schema — `Inspection.notes` becomes JSON

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_inspection_notes_json/` (generated)
- Delete: `src/inspections/dto/checklist-response-item.dto.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Inspection.notes: Prisma.JsonValue | null` on the generated client, replacing `checklistResponses`/old `notes`/`observations`/`recommendations`. Task 4 (Inspections DTOs/service) depends on this.

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Replace the `Inspection` model's field block:

```prisma
model Inspection {
  id         String           @id @default(uuid())
  requestId  String
  siteId     String
  engineerId String
  startTime  DateTime?
  endTime    DateTime?
  latitude   Decimal?         @db.Decimal(10, 8)
  longitude  Decimal?         @db.Decimal(11, 8)
  notes      Json?
  riskLevel  RiskLevel?
  status     InspectionStatus @default(draft)
  createdAt  DateTime         @default(now())
  updatedAt  DateTime         @updatedAt

  request  InspectionRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  site     Site              @relation(fields: [siteId], references: [id])
  engineer User              @relation(fields: [engineerId], references: [id])
  media    Media[]
  reports  Report[]
}
```

(Removed: `checklistResponses`, the old `observations`/`recommendations`
fields, and the old `String?` `notes`. Added: `notes Json?`.)

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm prisma migrate dev --name inspection_notes_json
```

Expected: generates `DROP COLUMN "checklistResponses"`, `DROP COLUMN
"observations"`, `DROP COLUMN "recommendations"`, drops the old `"notes"`
column and re-adds `"notes"` as `JSONB` — no hand-editing needed (plain
column changes, no PostGIS-style raw SQL this time). Applies cleanly and
regenerates the Prisma client.

- [ ] **Step 3: Delete the now-unused checklist item DTO**

```bash
rm src/inspections/dto/checklist-response-item.dto.ts
```

- [ ] **Step 4: Verify**

```bash
docker compose exec postgres psql -U postgres -d ujenzi_digital -c "\d \"Inspection\""
```

Expected: column list shows `notes` as `jsonb`, no `checklistResponses`/
`observations`/`recommendations` columns.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/inspections/dto/checklist-response-item.dto.ts
git commit -m "feat: replace Inspection checklist/notes fields with a single Json notes field"
```

(Building will fail until Task 4 updates the DTOs/service that still
reference the removed fields — that's expected; this task's commit is a
deliberate checkpoint, not a green build. Task 4 fixes it.)

---

### Task 2: `SitesService` shared site-tie check

**Files:**
- Modify: `src/sites/sites.service.ts`

**Interfaces:**
- Consumes: `PrismaService` (already injected).
- Produces: `SitesService.isTiedToSite(siteId: string, userId: string): Promise<boolean>` and `SitesService.resolveTiedSiteIds(userId: string): Promise<string[]>` — both exported via `SitesModule` (already exports `SitesService`). Tasks 3, 4, 5 all call these.

- [ ] **Step 1: Add the two methods to `SitesService`**

Add after `findWithinRadius` (before the `private haversineDistanceMeters`
method):

```typescript
  async isTiedToSite(siteId: string, userId: string): Promise<boolean> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { contractorId: true } });
    if (!site) {
      return false;
    }
    if (site.contractorId === userId) {
      return true;
    }
    const personnel = await this.prisma.sitePersonnel.findFirst({ where: { siteId, userId } });
    return !!personnel;
  }

  async resolveTiedSiteIds(userId: string): Promise<string[]> {
    const [personnelSites, ownedSites] = await Promise.all([
      this.prisma.sitePersonnel.findMany({ where: { userId }, select: { siteId: true } }),
      this.prisma.site.findMany({ where: { contractorId: userId }, select: { id: true } }),
    ]);
    const ids = new Set<string>();
    personnelSites.forEach((p) => ids.add(p.siteId));
    ownedSites.forEach((s) => ids.add(s.id));
    return [...ids];
  }
```

- [ ] **Step 2: Build**

```bash
pnpm run build
```

Expected: compiles cleanly (these methods aren't called by anything yet).

- [ ] **Step 3: Commit**

```bash
git add src/sites/sites.service.ts
git commit -m "feat: add SitesService.isTiedToSite/resolveTiedSiteIds shared authorization helpers"
```

---

### Task 3: `InspectionRequests` — roles, contractorId derivation, tie checks

**Files:**
- Modify: `src/inspection-requests/dto/create-inspection-request.dto.ts`
- Modify: `src/inspection-requests/dto/update-inspection-request.dto.ts`
- Modify: `src/inspection-requests/inspection-requests.module.ts`
- Modify: `src/inspection-requests/inspection-requests.service.ts`
- Modify: `src/inspection-requests/inspection-requests.controller.ts`

**Interfaces:**
- Consumes: `SitesService.isTiedToSite`/`resolveTiedSiteIds` (Task 2).
- Produces: `POST`/`PATCH /inspection-requests` now accept `developer`/`site_representative` callers. No other module depends on this task's internals.

- [ ] **Step 1: Rewrite `CreateInspectionRequestDto`**

`src/inspection-requests/dto/create-inspection-request.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateInspectionRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  siteId: string;

  @ApiProperty({ example: '2026-08-10' })
  @IsDateString()
  requestedDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
```

- [ ] **Step 2: Rewrite `UpdateInspectionRequestDto`**

`src/inspection-requests/dto/update-inspection-request.dto.ts`:

```typescript
import { PartialType } from '@nestjs/swagger';
import { CreateInspectionRequestDto } from './create-inspection-request.dto';

export class UpdateInspectionRequestDto extends PartialType(CreateInspectionRequestDto) {}
```

- [ ] **Step 3: Wire `SitesModule` into `InspectionRequestsModule`**

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SitesModule } from '../sites/sites.module';
import { InspectionRequestsController } from './inspection-requests.controller';
import { InspectionRequestsService } from './inspection-requests.service';

@Module({
  imports: [AuditLogModule, RealtimeModule, SitesModule],
  controllers: [InspectionRequestsController],
  providers: [InspectionRequestsService],
})
export class InspectionRequestsModule {}
```

- [ ] **Step 4: Rewrite `InspectionRequestsService`**

`src/inspection-requests/inspection-requests.service.ts`:

```typescript
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InspectionRequest, Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { SitesService } from '../sites/sites.service';
import { AcceptInspectionRequestDto } from './dto/accept-inspection-request.dto';
import { CreateInspectionRequestDto } from './dto/create-inspection-request.dto';
import { UpdateInspectionRequestDto } from './dto/update-inspection-request.dto';

const REQUEST_INCLUDE = {
  site: {
    select: { id: true, name: true, address: true, latitude: true, longitude: true, geofenceRadius: true },
  },
  contractor: { select: { id: true, name: true, company: true } },
  engineer: { select: { id: true, name: true } },
} as const;

@Injectable()
export class InspectionRequestsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private realtimeEventsService: RealtimeEventsService,
    private sitesService: SitesService,
  ) {}

  async findAll(user: AuthenticatedUser) {
    if (this.canSeeAll(user)) {
      return this.prisma.inspectionRequest.findMany({
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    }
    const siteIds = await this.sitesService.resolveTiedSiteIds(user.userId);
    return this.prisma.inspectionRequest.findMany({
      where: { siteId: { in: siteIds } },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const request = await this.findRequestOrThrow(id);
    await this.assertCanRead(request, user);
    return request;
  }

  async create(dto: CreateInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(dto.siteId);
    await this.assertTiedOrAdmin(site.id, user);

    const request = await this.prisma.inspectionRequest.create({
      data: {
        siteId: dto.siteId,
        contractorId: site.contractorId,
        requestedDate: new Date(dto.requestedDate),
        notes: dto.notes,
      },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(
      user.userId,
      'inspection_request.created',
      'InspectionRequest',
      request.id,
      { siteId: dto.siteId, contractorId: site.contractorId },
      ip,
    );

    await this.realtimeEventsService.emit(
      'inspection-request.created',
      request,
      { siteIds: [request.siteId], roles: ['engineer', 'administrator'] },
      { title: 'New inspection request', body: `${request.site.name} — requested by ${request.contractor.name}` },
    );

    return request;
  }

  async update(id: string, dto: UpdateInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    await this.assertCanEdit(request, user);

    let contractorId: string | undefined;
    if (dto.siteId) {
      const site = await this.findSiteOrThrow(dto.siteId);
      await this.assertTiedOrAdmin(site.id, user);
      contractorId = site.contractorId;
    }

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: {
        siteId: dto.siteId,
        contractorId,
        notes: dto.notes,
        requestedDate: dto.requestedDate ? new Date(dto.requestedDate) : undefined,
      },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(user.userId, 'inspection_request.updated', 'InspectionRequest', id, { ...dto }, ip);

    return updated;
  }

  async accept(id: string, dto: AcceptInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertPending(request);
    const engineerId = this.resolveEngineerId(dto, user);

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: { status: 'accepted', engineerId },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(
      user.userId,
      'inspection_request.accepted',
      'InspectionRequest',
      id,
      { engineerId },
      ip,
    );

    await this.realtimeEventsService.emit(
      'inspection-request.accepted',
      updated,
      { siteIds: [updated.siteId] },
      {
        title: 'Inspection request accepted',
        body: `${updated.site.name} — accepted by ${updated.engineer?.name ?? 'an engineer'}`,
      },
    );

    return updated;
  }

  async reject(id: string, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertPending(request);

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: { status: 'rejected' },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(user.userId, 'inspection_request.rejected', 'InspectionRequest', id, undefined, ip);

    await this.realtimeEventsService.emit(
      'inspection-request.rejected',
      updated,
      { siteIds: [updated.siteId] },
      { title: 'Inspection request rejected', body: updated.site.name },
    );

    return updated;
  }

  private canSeeAll(user: AuthenticatedUser): boolean {
    return user.roles.includes('engineer') || user.roles.includes('administrator');
  }

  private async assertTiedOrAdmin(siteId: string, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    const tied = await this.sitesService.isTiedToSite(siteId, user.userId);
    if (!tied) {
      throw new ForbiddenException('You are not tied to this site');
    }
  }

  private resolveEngineerId(dto: AcceptInspectionRequestDto, user: AuthenticatedUser): string {
    if (user.roles.includes('administrator')) {
      if (!dto.engineerId) {
        throw new ForbiddenException('engineerId is required when an administrator accepts a request');
      }
      return dto.engineerId;
    }
    return user.userId;
  }

  private assertPending(request: InspectionRequest) {
    if (request.status !== 'pending') {
      throw new ConflictException('Only pending requests can be accepted or rejected');
    }
  }

  private async assertCanRead(request: InspectionRequest, user: AuthenticatedUser) {
    if (this.canSeeAll(user)) {
      return;
    }
    if (!(await this.sitesService.isTiedToSite(request.siteId, user.userId))) {
      throw new ForbiddenException('You do not have access to this inspection request');
    }
  }

  private async assertCanEdit(request: InspectionRequest, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    if (!(await this.sitesService.isTiedToSite(request.siteId, user.userId))) {
      throw new ForbiddenException('You do not have access to this inspection request');
    }
    if (request.status !== 'pending') {
      throw new ForbiddenException('This request can no longer be edited');
    }
  }

  private async findSiteOrThrow(siteId: string): Promise<Site> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return site;
  }

  private async findRequestOrThrow(id: string) {
    const request = await this.prisma.inspectionRequest.findUnique({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    if (!request) {
      throw new NotFoundException('Inspection request not found');
    }
    return request;
  }
}
```

- [ ] **Step 5: Update `InspectionRequestsController` roles**

Modify `src/inspection-requests/inspection-requests.controller.ts` — change
the `create` and `update` methods' `@Roles(...)`:

```typescript
  @ApiOperation({ summary: 'Create an inspection request (any user tied to the site, or administrator)' })
  @Roles('contractor', 'developer', 'site_representative', 'administrator')
  @Post()
  create(
```

```typescript
  @ApiOperation({ summary: 'Update an inspection request (any user tied to the site while pending, or administrator anytime)' })
  @Roles('contractor', 'developer', 'site_representative', 'administrator')
  @Patch(':id')
  update(
```

(Only the `@ApiOperation`/`@Roles` lines change; method bodies stay as-is —
they already just forward to the service.)

- [ ] **Step 6: Build**

```bash
pnpm run build
```

- [ ] **Step 7: Manually verify with two site-tied roles and one unrelated user**

```bash
pnpm run start:dev
```

Sign up a contractor, create a site, sign up a developer, sign up an
unrelated contractor with their own separate site, then use
`docker compose exec postgres psql` to insert a `SitePersonnel` row tying
the developer to the first contractor's site:

```bash
CONTRACTOR_TOKEN=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"redesign-contractor@example.com","password":"password123","name":"Redesign Contractor","roles":["contractor"]}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

SITE_ID=$(curl -s -X POST http://localhost:5000/sites -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Redesign Test Site","latitude":-1.28,"longitude":36.81,"address":"1 Redesign Way"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

DEV_SIGNUP=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"redesign-developer@example.com","password":"password123","name":"Redesign Developer","roles":["developer"]}')
DEVELOPER_TOKEN=$(echo "$DEV_SIGNUP" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
DEVELOPER_ID=$(echo "$DEV_SIGNUP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

docker compose exec postgres psql -U postgres -d ujenzi_digital -c \
  "INSERT INTO \"SitePersonnel\" (id, \"siteId\", role, \"userId\") VALUES (gen_random_uuid(), '$SITE_ID', 'DEVELOPER', '$DEVELOPER_ID');"

UNRELATED_TOKEN=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"redesign-unrelated@example.com","password":"password123","name":"Redesign Unrelated","roles":["contractor"]}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
```

```bash
# Developer (tied via SitePersonnel) can create a request for this site
curl -i -X POST http://localhost:5000/inspection-requests -H "Authorization: Bearer $DEVELOPER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":\"$SITE_ID\",\"requestedDate\":\"2026-08-25\"}"
```

Expected: `201 Created`, response's `contractorId` equals the ORIGINAL
contractor's id (not the developer's), confirming server-side derivation.

```bash
# Unrelated contractor cannot create a request for this site
curl -i -X POST http://localhost:5000/inspection-requests -H "Authorization: Bearer $UNRELATED_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":\"$SITE_ID\",\"requestedDate\":\"2026-08-25\"}"
```

Expected: `403 Forbidden`.

```bash
# The developer can list and see the request they just created
curl -s http://localhost:5000/inspection-requests -H "Authorization: Bearer $DEVELOPER_TOKEN"
# The unrelated contractor's list does not include it
curl -s http://localhost:5000/inspection-requests -H "Authorization: Bearer $UNRELATED_TOKEN"
```

Expected: first call's array includes the new request; second call's array
is empty (or excludes it). Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/inspection-requests
git commit -m "feat: widen inspection-request creation to developer/site_representative with server-derived contractorId"
```

---

### Task 4: `Inspections` — notes field, read-access tie check

**Files:**
- Modify: `src/inspections/dto/update-inspection.dto.ts`
- Modify: `src/inspections/inspections.service.ts`
- Modify: `src/inspections/inspections.controller.ts`

**Interfaces:**
- Consumes: `SitesService.isTiedToSite` (Task 2), `Inspection.notes: Json?` (Task 1).
- Produces: `GET /inspections/:id` now requires `@CurrentUser()`; nothing else in this plan depends on this task's internals (frontend consumes the resulting shapes in Task 8/9, not any exported type).

- [ ] **Step 1: Rewrite `UpdateInspectionDto`**

`src/inspections/dto/update-inspection.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RiskLevel } from '@prisma/client';
import { IsObject, IsOptional } from 'class-validator';

export class UpdateInspectionDto {
  @ApiPropertyOptional({ description: 'Tiptap/ProseMirror JSON document.' })
  @IsOptional()
  @IsObject()
  notes?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: RiskLevel })
  @IsOptional()
  riskLevel?: RiskLevel;
}
```

(`SubmitInspectionDto` in `submit-inspection.dto.ts` needs no change — it
already just extends `UpdateInspectionDto` and adds `latitude`/`longitude`.)

- [ ] **Step 2: Update `InspectionsService`**

Modify `src/inspections/inspections.service.ts`:

Add the import:

```typescript
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
```

(already imported — no change needed there.)

Replace `findAll`/`findOne`:

```typescript
  async findAll(user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return this.prisma.inspection.findMany({
        include: INSPECTION_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    }
    const siteIds = await this.sitesService.resolveTiedSiteIds(user.userId);
    return this.prisma.inspection.findMany({
      where: { OR: [{ siteId: { in: siteIds } }, { engineerId: user.userId }] },
      include: INSPECTION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const inspection = await this.findInspectionOrThrow(id);
    await this.assertCanView(inspection, user);
    return inspection;
  }
```

Add a new private method (alongside the existing `assertOwnerOrAdmin`):

```typescript
  private async assertCanView(inspection: Inspection, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    if (inspection.engineerId === user.userId) {
      return;
    }
    if (!(await this.sitesService.isTiedToSite(inspection.siteId, user.userId))) {
      throw new ForbiddenException('You do not have access to this inspection');
    }
  }
```

In `update()` and `submit()`, replace the `data:` blocks' field lists —
remove `observations`, `recommendations`, and the `checklistResponses`
cast, keep `notes`/`riskLevel`:

```typescript
      data: {
        notes: dto.notes as unknown as Prisma.InputJsonValue | undefined,
        riskLevel: dto.riskLevel,
      },
```

(for `update()`; `submit()`'s `data:` block keeps this same
`notes`/`riskLevel` pair plus its existing `latitude`/`longitude`/
`endTime`/`status` fields unchanged.)

- [ ] **Step 3: Update `InspectionsController`**

Modify `src/inspections/inspections.controller.ts` — add `@CurrentUser()`
to both GET routes:

```typescript
  @ApiOperation({ summary: 'List inspections (tied users see their sites\' inspections; administrators see all)' })
  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.inspectionsService.findAll(user);
  }

  @ApiOperation({ summary: 'Get an inspection by id (tied users, the assigned engineer, or an administrator)' })
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inspectionsService.findOne(id, user);
  }
```

- [ ] **Step 4: Build**

```bash
pnpm run build
```

- [ ] **Step 5: Manually verify**

```bash
pnpm run start:dev
```

Reuse `$SITE_ID`/`$DEVELOPER_TOKEN`/`$UNRELATED_TOKEN` from Task 3's
verification session (or recreate them if that dev server was restarted).
Have an engineer accept the request and start an inspection, then confirm:

```bash
ENGINEER_TOKEN=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"redesign-engineer@example.com","password":"password123","name":"Redesign Engineer","roles":["engineer"]}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

REQUEST_ID=$(curl -s http://localhost:5000/inspection-requests -H "Authorization: Bearer $ENGINEER_TOKEN" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s -X POST http://localhost:5000/inspection-requests/$REQUEST_ID/accept -H "Authorization: Bearer $ENGINEER_TOKEN" > /dev/null

INSPECTION_ID=$(curl -s -X POST http://localhost:5000/inspections -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQUEST_ID\",\"latitude\":-1.28,\"longitude\":36.81}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# Developer (tied to the site) can view it
curl -i http://localhost:5000/inspections/$INSPECTION_ID -H "Authorization: Bearer $DEVELOPER_TOKEN"
# Unrelated contractor cannot
curl -i http://localhost:5000/inspections/$INSPECTION_ID -H "Authorization: Bearer $UNRELATED_TOKEN"
# Developer cannot edit it (still engineer/admin-only for writes)
curl -i -X PATCH http://localhost:5000/inspections/$INSPECTION_ID -H "Authorization: Bearer $DEVELOPER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"riskLevel":"low"}'
# Engineer can save a Tiptap-shaped notes document
curl -i -X PATCH http://localhost:5000/inspections/$INSPECTION_ID -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"notes":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"All clear"}]}]},"riskLevel":"low"}'
```

Expected: developer's GET → `200`; unrelated's GET → `403`; developer's
PATCH → `403` (write still engineer/admin-only, but note the controller's
`@Roles('engineer','administrator')` already blocks this before the service
is even reached); engineer's PATCH → `200` with the notes document echoed
back. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add src/inspections
git commit -m "feat: replace inspection checklist with Json notes, add site-tie read access"
```

---

### Task 5: `Media` — read-access tie check

**Files:**
- Modify: `src/media/media.module.ts`
- Modify: `src/media/media.service.ts`
- Modify: `src/media/media.controller.ts`

**Interfaces:**
- Consumes: `SitesService.isTiedToSite` (Task 2).
- Produces: `GET /inspections/:inspectionId/media` and `GET /media/:id/file` now require `@CurrentUser()` and enforce the tie check. Frontend Task 8 calls these same routes (unchanged paths/shapes) — only their authorization behavior changes.

- [ ] **Step 1: Wire `SitesModule` into `MediaModule`**

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SitesModule } from '../sites/sites.module';
import { StorageModule } from '../storage/storage.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [AuditLogModule, StorageModule, SitesModule],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
```

- [ ] **Step 2: Update `MediaService`**

Modify `src/media/media.service.ts` — add the import and constructor param:

```typescript
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { SitesService } from '../sites/sites.service';
// ...
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private auditLogService: AuditLogService,
    private sitesService: SitesService,
  ) {}
```

Replace `findAllForInspection` and `getFileStream`:

```typescript
  async findAllForInspection(inspectionId: string, user: AuthenticatedUser) {
    const inspection = await this.prisma.inspection.findUnique({ where: { id: inspectionId } });
    if (!inspection) {
      throw new NotFoundException('Inspection not found');
    }
    await this.assertCanView(inspection.siteId, inspection.engineerId, user);

    return this.prisma.media.findMany({
      where: { inspectionId },
      orderBy: { createdAt: 'desc' },
    });
  }
```

```typescript
  async getFileStream(id: string, user: AuthenticatedUser) {
    const media = await this.findMediaOrThrow(id);
    const inspection = await this.prisma.inspection.findUniqueOrThrow({ where: { id: media.inspectionId } });
    await this.assertCanView(inspection.siteId, inspection.engineerId, user);

    return { stream: this.storageService.read(media.url), extension: path.extname(media.url) };
  }
```

Add the new private method (alongside the existing `assertOwnerOrAdmin`):

```typescript
  private async assertCanView(siteId: string, engineerId: string, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    if (engineerId === user.userId) {
      return;
    }
    if (!(await this.sitesService.isTiedToSite(siteId, user.userId))) {
      throw new ForbiddenException('You do not have access to this inspection');
    }
  }
```

- [ ] **Step 3: Update `MediaController`**

Modify `src/media/media.controller.ts` — add `@CurrentUser()` to both
routes:

```typescript
  @ApiOperation({ summary: "List all media for an inspection (tied users, the assigned engineer, or an administrator)" })
  @Get('inspections/:inspectionId/media')
  findAllForInspection(@Param('inspectionId') inspectionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.mediaService.findAllForInspection(inspectionId, user);
  }
```

```typescript
  @ApiOperation({ summary: 'Stream a media file (tied users, the assigned engineer, or an administrator)' })
  @Get('media/:id/file')
  async getFile(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Res() res: Response) {
    const { stream, extension } = await this.mediaService.getFileStream(id, user);
    res.set('Content-Type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({ statusCode: 404, message: 'Media file not found', error: 'Not Found' });
      }
    });
    stream.pipe(res);
  }
```

- [ ] **Step 4: Build**

```bash
pnpm run build
```

- [ ] **Step 5: Manually verify**

```bash
pnpm run start:dev
```

Reuse `$INSPECTION_ID`/`$ENGINEER_TOKEN`/`$DEVELOPER_TOKEN`/
`$UNRELATED_TOKEN` from Task 4's session (recreate if the server restarted).

```bash
# Engineer uploads a photo (needs the inspection in_progress, which it is)
curl -s -X POST "http://localhost:5000/inspections/$INSPECTION_ID/media" -H "Authorization: Bearer $ENGINEER_TOKEN" \
  -F "file=@C:/Windows/System32/oobe/info/background.jpg;type=image/jpeg" \
  -F "latitude=-1.28" -F "longitude=36.81" -F "caption=test photo"
```

(If that sample file path doesn't exist on this machine, use any small
local `.jpg`/`.png` file instead — the specific image content doesn't
matter, only that it's a valid image file.)

```bash
# Developer (tied to the site) can list and view it
curl -i http://localhost:5000/inspections/$INSPECTION_ID/media -H "Authorization: Bearer $DEVELOPER_TOKEN"
# Unrelated contractor cannot
curl -i http://localhost:5000/inspections/$INSPECTION_ID/media -H "Authorization: Bearer $UNRELATED_TOKEN"
```

Expected: developer's list → `200` with one media item; unrelated's →
`403`. Grab the media `id` from the developer's response and confirm file
streaming follows the same rule:

```bash
curl -i http://localhost:5000/media/<media-id>/file -H "Authorization: Bearer $DEVELOPER_TOKEN"
curl -i http://localhost:5000/media/<media-id>/file -H "Authorization: Bearer $UNRELATED_TOKEN"
```

Expected: `200` then `403`. Stop the dev server, clean up all test data
(users, site, request, inspection, media — via `docker compose exec
postgres psql`).

- [ ] **Step 6: Commit**

```bash
git add src/media
git commit -m "feat: add site-tie read access check to media listing and file streaming"
```

---

### Task 6: sitesight-pro — fix `usePermissions.ts`

**Files:**
- Modify: `src/hooks/usePermissions.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: corrected `rolePermissions.developer`/`rolePermissions.site_representative` — Task 7 (`QuickActions.tsx`) reads these via `checkPermission`.

- [ ] **Step 1: Fix the `developer` and `site_representative` entries**

Modify `src/hooks/usePermissions.ts`:

```typescript
  site_representative: [
    'view_sites',
    'view_inspections',
    'create_inspection_requests',
    'view_reports',
  ],
  // developer is a client/project-owner role, a peer to contractor/site_representative
  // — not an administrator-equivalent. Site-creation permissions are undecided here;
  // that's Spec 4's call when it builds the site-registration flow.
  developer: [
    'view_sites',
    'view_inspections',
    'create_inspection_requests',
    'view_reports',
  ],
```

(Replaces both the `site_representative` array, which gains
`'create_inspection_requests'`, and the `developer` array, which drops
every admin-equivalent permission and the stale comment above it.)

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePermissions.ts
git commit -m "fix: correct developer/site_representative permission mappings"
```

---

### Task 7: sitesight-pro — gate `QuickActions.tsx` tiles

**Files:**
- Modify: `src/components/dashboard/QuickActions.tsx`

**Interfaces:**
- Consumes: `usePermissions()`/`checkPermission` (Task 6, already exists), `useAppSelector` + `state.auth.roles` (existing).
- Produces: nothing consumed elsewhere in this plan.

- [ ] **Step 1: Add role-based filtering**

Modify `src/components/dashboard/QuickActions.tsx`:

```typescript
import { Plus, MapPin, ClipboardCheck, FileText, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useGetInspectionRequestsQuery } from "@/store/api/inspectionsApi";
import { useMemo } from "react";
import { motion } from "framer-motion";
import { useAppSelector } from "@/store/hooks";
import { usePermissions } from "@/hooks/usePermissions";

interface QuickAction {
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  href: string;
  gradient: string;
  iconBg: string;
}

export function QuickActions() {
  const { data: requests = [] } = useGetInspectionRequestsQuery();
  const acceptedRequest = requests.find(r => r.status === 'accepted');
  const roles = useAppSelector((state) => state.auth.roles);
  const { checkPermission } = usePermissions();

  const actions: QuickAction[] = useMemo(
    () => [
      ...(checkPermission(roles, 'perform_inspections')
        ? [{
            key: 'start-inspection',
            icon: ClipboardCheck,
            label: "Start Inspection",
            description: "Begin a new site inspection",
            href: acceptedRequest ? `/inspections/${acceptedRequest.id}` : "/inspections",
            gradient: "from-accent to-orange-600",
            iconBg: "bg-accent",
          }]
        : []),
      ...(checkPermission(roles, 'create_inspection_requests')
        ? [{
            key: 'new-request',
            icon: Plus,
            label: "New Request",
            description: "Request an inspection",
            href: "/inspections/request/new",
            gradient: "from-primary to-blue-700",
            iconBg: "bg-primary",
          }]
        : []),
      {
        key: 'view-sites',
        icon: MapPin,
        label: "View Sites",
        description: "Manage construction sites",
        href: "/sites",
        gradient: "from-info to-cyan-600",
        iconBg: "bg-info",
      },
      {
        key: 'reports',
        icon: FileText,
        label: "Reports",
        description: "View inspection reports",
        href: "/reports",
        gradient: "from-success to-emerald-600",
        iconBg: "bg-success",
      },
    ],
    [acceptedRequest, roles, checkPermission]
  );

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {actions.map((action, index) => {
        const Icon = action.icon;
        return (
          <motion.div
            key={action.key}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
          >
            <Link
              to={action.href}
              className="card-elevated p-5 flex flex-col gap-4 hover:shadow-xl transition-all duration-300 group relative overflow-hidden"
            >
              <div className={cn(
                "absolute inset-0 opacity-0 group-hover:opacity-5 transition-opacity duration-300 bg-gradient-to-br",
                action.gradient
              )} />

              <div className={cn(
                "p-3.5 rounded-xl w-fit transition-all duration-300 group-hover:scale-110 group-hover:shadow-lg",
                action.iconBg,
                "text-white"
              )}>
                <Icon className="h-6 w-6" />
              </div>

              <div className="space-y-1 relative">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                    {action.label}
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
                </div>
                <p className="text-xs text-muted-foreground line-clamp-1">
                  {action.description}
                </p>
              </div>
            </Link>
          </motion.div>
        );
      })}
    </div>
  );
}
```

(Key change: tiles are now built conditionally via spread-if-true array
literals, keyed by a stable `key` field instead of `href` since two roles
could theoretically share an href. `Camera` import removed — it was
unused in the original file.)

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Manually verify in the browser**

Log in as a contractor: confirm "Start Inspection" is absent, "New
Request" is present. Log in as an engineer: confirm "Start Inspection" is
present, "New Request" is absent.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/QuickActions.tsx
git commit -m "feat: gate Start Inspection/New Request tiles by permission"
```

---

### Task 8: sitesight-pro — `inspectionsApi.ts` types and media endpoints

**Files:**
- Modify: `src/store/api/inspectionsApi.ts`

**Interfaces:**
- Consumes: the backend shapes from Tasks 4–5 (`notes: object | null` instead of `string`, no `checklistResponses`/`observations`/`recommendations`; `GET/POST /inspections/:id/media`, `DELETE /media/:id`).
- Produces: `useGetInspectionMediaQuery`, `useUploadInspectionMediaMutation`, `useDeleteMediaMutation` — Task 9 (`InspectionForm.tsx`) uses all three. `Inspection.notes` type change — Task 9 also depends on this.

- [ ] **Step 1: Update types and remove checklist fields**

Modify `src/store/api/inspectionsApi.ts`:

Remove the `ChecklistItem` interface entirely. Replace the `Inspection`
interface's body (drop `checklist_responses`/`observations`/
`recommendations`, change `notes` type):

```typescript
export interface Inspection {
  id: string;
  request_id: string;
  site_id: string;
  engineer_id: string;
  start_time?: string;
  end_time?: string;
  latitude?: number;
  longitude?: number;
  notes?: Record<string, unknown>;
  risk_level?: RiskLevel;
  status: 'draft' | 'in_progress' | 'submitted';
  created_at: string;
  updated_at: string;
  site_name?: string;
  site_address?: string;
  engineer_name?: string;
}
```

Update `BackendInspection` the same way (drop `checklistResponses`/
`observations`/`recommendations`, `notes: Record<string, unknown> | null`):

```typescript
interface BackendInspection {
  id: string;
  requestId: string;
  siteId: string;
  engineerId: string;
  startTime: string | null;
  endTime: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  notes: Record<string, unknown> | null;
  riskLevel: RiskLevel | null;
  status: 'draft' | 'in_progress' | 'submitted';
  createdAt: string;
  updatedAt: string;
  site: { id: string; name: string; address: string } | null;
  engineer: { id: string; name: string } | null;
}
```

Update `mapInspection` to match (drop the three removed fields' mapping,
`notes: i.notes ?? undefined`):

```typescript
function mapInspection(i: BackendInspection): Inspection {
  return {
    id: i.id,
    request_id: i.requestId,
    site_id: i.siteId,
    engineer_id: i.engineerId,
    start_time: i.startTime ?? undefined,
    end_time: i.endTime ?? undefined,
    latitude: i.latitude != null ? Number(i.latitude) : undefined,
    longitude: i.longitude != null ? Number(i.longitude) : undefined,
    notes: i.notes ?? undefined,
    risk_level: i.riskLevel ?? undefined,
    status: i.status,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    site_name: i.site?.name,
    site_address: i.site?.address,
    engineer_name: i.engineer?.name,
  };
}
```

Update the payload interfaces:

```typescript
export interface SaveInspectionDraftPayload {
  id: string;
  notes?: Record<string, unknown>;
  riskLevel?: RiskLevel;
}

export interface SubmitInspectionPayload extends SaveInspectionDraftPayload {
  latitude: number;
  longitude: number;
}
```

- [ ] **Step 2: Add the `Media` type and three endpoints**

Add near the top (after the `RiskLevel` type):

```typescript
export interface Media {
  id: string;
  inspectionId: string;
  type: 'photo' | 'video';
  url: string;
  latitude?: number;
  longitude?: number;
  caption?: string;
  createdAt: string;
}

export interface UploadInspectionMediaPayload {
  inspectionId: string;
  file: File;
  latitude: number;
  longitude: number;
  caption?: string;
}
```

Add three endpoints inside `inspectionsApi.injectEndpoints`'s `endpoints:`
object, after `submitInspection`:

```typescript
    getInspectionMedia: builder.query<Media[], string>({
      query: (inspectionId) => `/inspections/${inspectionId}/media`,
      providesTags: (result, _error, inspectionId) => [
        ...(result ?? []).map((m) => ({ type: 'Media' as const, id: m.id })),
        { type: 'Media' as const, id: `LIST-${inspectionId}` },
      ],
    }),
    uploadInspectionMedia: builder.mutation<Media, UploadInspectionMediaPayload>({
      query: ({ inspectionId, file, latitude, longitude, caption }) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('latitude', String(latitude));
        formData.append('longitude', String(longitude));
        if (caption) formData.append('caption', caption);
        return { url: `/inspections/${inspectionId}/media`, method: 'POST', body: formData };
      },
      invalidatesTags: (_result, _error, { inspectionId }) => [
        { type: 'Media' as const, id: `LIST-${inspectionId}` },
      ],
    }),
    deleteMedia: builder.mutation<void, { id: string; inspectionId: string }>({
      query: ({ id }) => ({ url: `/media/${id}`, method: 'DELETE' }),
      invalidatesTags: (_result, _error, { inspectionId }) => [
        { type: 'Media' as const, id: `LIST-${inspectionId}` },
      ],
    }),
```

Add the corresponding hooks to the final export block:

```typescript
export const {
  useGetInspectionRequestsQuery,
  useGetInspectionRequestQuery,
  useCreateInspectionRequestMutation,
  useAcceptInspectionRequestMutation,
  useRejectInspectionRequestMutation,
  useGetInspectionsQuery,
  useStartInspectionMutation,
  useSaveInspectionDraftMutation,
  useSubmitInspectionMutation,
  useGetInspectionMediaQuery,
  useUploadInspectionMediaMutation,
  useDeleteMediaMutation,
} = inspectionsApi;
```

- [ ] **Step 3: Add the `Media` tag type to `baseApi.ts`**

Modify `src/store/api/baseApi.ts` — add `'Media'` to the existing
`tagTypes` array (read the file first; it currently has 4 entries
including a `'User'` tag added by unrelated parallel work — append
`'Media'` as a 5th, don't overwrite the existing list):

```typescript
  tagTypes: ['Site', 'InspectionRequest', 'Inspection', 'User', 'Media'],
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: errors in `InspectionForm.tsx` (still referencing removed
fields) — that's fine, Task 9 fixes it.

- [ ] **Step 5: Commit**

```bash
git add src/store/api/inspectionsApi.ts src/store/api/baseApi.ts
git commit -m "feat: add media endpoints, replace checklist/notes types with Json notes"
```

---

### Task 9: sitesight-pro — rewrite `InspectionForm.tsx`

**Files:**
- Modify: `package.json` (add Tiptap deps)
- Modify: `src/pages/InspectionForm.tsx`

**Interfaces:**
- Consumes: `useGetInspectionMediaQuery`/`useUploadInspectionMediaMutation`/`useDeleteMediaMutation` (Task 8), `Inspection.notes: Record<string, unknown> | undefined` (Task 8).
- Produces: nothing consumed elsewhere in this plan — last task.

- [ ] **Step 1: Install Tiptap**

```bash
npm install @tiptap/react @tiptap/pm @tiptap/starter-kit
```

- [ ] **Step 2: Rewrite `InspectionForm.tsx`**

`src/pages/InspectionForm.tsx`:

```tsx
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  ArrowLeft,
  MapPin,
  Camera,
  AlertTriangle,
  Save,
  Send,
  Navigation,
  Trash2,
  Bold,
  Italic,
  List,
} from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import {
  useGetInspectionRequestQuery,
  useGetInspectionsQuery,
  useStartInspectionMutation,
  useSaveInspectionDraftMutation,
  useSubmitInspectionMutation,
  useGetInspectionMediaQuery,
  useUploadInspectionMediaMutation,
  useDeleteMediaMutation,
  type Inspection,
  type RiskLevel,
} from '@/store/api/inspectionsApi';
import { useGeolocation } from '@/hooks/useGeolocation';

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

export default function InspectionForm() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: request } = useGetInspectionRequestQuery(id ?? '', { skip: !id });
  const { data: inspections = [] } = useGetInspectionsQuery();
  const { latitude, longitude, error: geoError, getCurrentPosition, loading: geoLoading } = useGeolocation();

  const [startInspection, { isLoading: starting }] = useStartInspectionMutation();
  const [saveInspectionDraft, { isLoading: saving }] = useSaveInspectionDraftMutation();
  const [submitInspection, { isLoading: submitting }] = useSubmitInspectionMutation();
  const loading = starting || saving || submitting;

  const [riskLevel, setRiskLevel] = useState<RiskLevel>('low');
  const [isWithinBoundary, setIsWithinBoundary] = useState(true);
  const [currentInspection, setCurrentInspection] = useState<Inspection | null>(null);

  const { data: media = [] } = useGetInspectionMediaQuery(currentInspection?.id ?? '', {
    skip: !currentInspection,
  });
  const [uploadMedia, { isLoading: uploading }] = useUploadInspectionMediaMutation();
  const [deleteMedia] = useDeleteMediaMutation();

  const editor = useEditor({
    extensions: [StarterKit],
    content: EMPTY_DOC,
  });

  useEffect(() => {
    getCurrentPosition();
  }, [getCurrentPosition]);

  // Resuming a request that already has an in-progress inspection.
  useEffect(() => {
    if (currentInspection || !id) return;
    const existing = inspections.find((i) => i.request_id === id);
    if (existing) setCurrentInspection(existing);
  }, [inspections, id, currentInspection]);

  // Seed the form from the persisted inspection once, keyed on id so later
  // autosaves (which replace this same object) don't clobber in-progress edits.
  useEffect(() => {
    if (!currentInspection || !editor) return;
    editor.commands.setContent(currentInspection.notes ?? EMPTY_DOC);
    if (currentInspection.risk_level) setRiskLevel(currentInspection.risk_level);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentInspection?.id, editor]);

  useEffect(() => {
    if (request && latitude !== null && longitude !== null) {
      setIsWithinBoundary(true);
    }
  }, [request, latitude, longitude]);

  const handleStartInspection = async () => {
    if (!request || latitude == null || longitude == null) return;

    if (!isWithinBoundary) {
      toast({
        title: 'Outside geofence',
        description: 'You must be at the construction site to start the inspection.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const inspection = await startInspection({
        requestId: request.id,
        latitude,
        longitude,
      }).unwrap();

      setCurrentInspection(inspection);
      toast({
        title: 'Inspection started',
        description: 'You can now add notes and photos.',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to start inspection.',
        variant: 'destructive',
      });
    }
  };

  const handleSaveDraft = async () => {
    if (!currentInspection || !editor) return;

    try {
      const updated = await saveInspectionDraft({
        id: currentInspection.id,
        notes: editor.getJSON(),
        riskLevel,
      }).unwrap();

      setCurrentInspection(updated);
      toast({
        title: 'Draft saved',
        description: 'Your progress has been saved.',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to save draft.',
        variant: 'destructive',
      });
    }
  };

  const handleSubmit = async () => {
    if (!currentInspection || !editor || latitude == null || longitude == null) return;

    if (!isWithinBoundary) {
      toast({
        title: 'Outside geofence',
        description: 'You must be at the site to submit the inspection report.',
        variant: 'destructive',
      });
      return;
    }

    try {
      await submitInspection({
        id: currentInspection.id,
        notes: editor.getJSON(),
        riskLevel,
        latitude,
        longitude,
      }).unwrap();

      toast({
        title: 'Inspection submitted',
        description: 'The inspection report has been submitted successfully.',
      });
      navigate('/inspections');
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to submit inspection.',
        variant: 'destructive',
      });
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !currentInspection || latitude == null || longitude == null) return;

    try {
      await uploadMedia({
        inspectionId: currentInspection.id,
        file,
        latitude,
        longitude,
      }).unwrap();
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to upload photo.', variant: 'destructive' });
    }
  };

  const handleDeleteMedia = async (mediaId: string) => {
    if (!currentInspection) return;
    try {
      await deleteMedia({ id: mediaId, inspectionId: currentInspection.id }).unwrap();
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to delete photo.', variant: 'destructive' });
    }
  };

  if (!request) {
    return (
      <AppLayout>
        <PageHeader title="Loading..." />
        <div className="p-4">
          <div className="animate-pulse space-y-4">
            <div className="h-32 bg-muted rounded-xl" />
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <PageHeader
        title="Inspection"
        subtitle={request.site_name}
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        }
      />

      <div className="p-4 space-y-4 animate-fade-in">
        {/* Location Status */}
        <Card className={isWithinBoundary ? 'border-success' : 'border-warning'}>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div
                className={`p-2.5 rounded-lg ${
                  isWithinBoundary ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
                }`}
              >
                <Navigation className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="font-medium text-foreground">
                  {isWithinBoundary ? 'Inside Geofence' : 'Outside Geofence'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {geoLoading
                    ? 'Getting location...'
                    : geoError ||
                      `Lat: ${latitude?.toFixed(4)}, Lon: ${longitude?.toFixed(4)}`}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={getCurrentPosition} disabled={geoLoading}>
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>

        {!isWithinBoundary && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              You must be within {request.site_geofence_radius || 100}m of the site to perform this
              inspection.
            </AlertDescription>
          </Alert>
        )}

        {/* Start Inspection */}
        {!currentInspection && (
          <Button
            onClick={handleStartInspection}
            disabled={!isWithinBoundary || loading}
            className="w-full"
          >
            <MapPin className="h-4 w-4 mr-2" />
            Start Inspection
          </Button>
        )}

        {/* Inspection Form */}
        {currentInspection && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5" />
                  Risk Assessment
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Overall Risk Level</Label>
                  <Select value={riskLevel} onValueChange={(v: RiskLevel) => setRiskLevel(v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low - No significant issues</SelectItem>
                      <SelectItem value="medium">Medium - Minor issues found</SelectItem>
                      <SelectItem value="high">High - Significant issues</SelectItem>
                      <SelectItem value="critical">Critical - Immediate action required</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Notes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {editor && (
                  <div className="flex gap-1 border-b pb-2">
                    <Button
                      type="button"
                      variant={editor.isActive('bold') ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => editor.chain().focus().toggleBold().run()}
                    >
                      <Bold className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant={editor.isActive('italic') ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => editor.chain().focus().toggleItalic().run()}
                    >
                      <Italic className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant={editor.isActive('bulletList') ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => editor.chain().focus().toggleBulletList().run()}
                    >
                      <List className="h-4 w-4" />
                    </Button>
                  </div>
                )}
                <EditorContent
                  editor={editor}
                  className="min-h-[150px] rounded-md border px-3 py-2 prose prose-sm max-w-none focus-within:ring-1 focus-within:ring-ring"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Camera className="h-5 w-5" />
                  Photos
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileSelected}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <Camera className="h-4 w-4 mr-2" />
                  Add Photo
                </Button>
                {media.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {media.map((m) => (
                      <div key={m.id} className="relative group">
                        <img
                          src={`${import.meta.env.VITE_API_URL}/media/${m.id}/file`}
                          alt={m.caption ?? 'Inspection photo'}
                          className="aspect-square w-full rounded-md object-cover"
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="icon"
                          className="absolute top-1 right-1 h-6 w-6 opacity-0 group-hover:opacity-100"
                          onClick={() => handleDeleteMedia(m.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Actions */}
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleSaveDraft} className="flex-1">
                <Save className="h-4 w-4 mr-2" />
                Save Draft
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!isWithinBoundary || loading}
                className="flex-1"
              >
                <Send className="h-4 w-4 mr-2" />
                Submit
              </Button>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
```

(Removed: the entire checklist section, `defaultChecklist`, `checklist`
state, `handleChecklistChange`/`handleChecklistNotes`, `observations`/
`recommendations` state and their `Textarea` fields, the unanswered-item
submit-blocking check. Added: Tiptap editor + toolbar, Photos card wired to
the three new media endpoints. `fetchBaseQuery`'s multipart handling in
`baseApi.ts` — confirm `prepareHeaders` doesn't force
`Content-Type: application/json` for `FormData` bodies; if it does, that's
a fix needed inside this same task, not a separate one, since the photo
upload can't work otherwise.)

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Manually verify in the browser**

Start both dev servers. Log in as an engineer, accept a request, start an
inspection. Confirm: the Tiptap editor renders and the toolbar's Bold/
Italic/Bullet-list buttons work; "Save Draft" persists notes (reload the
page and confirm they're still there); "Add Photo" uploads a file and it
appears as a thumbnail; hovering a thumbnail and clicking the trash icon
removes it; "Submit" completes the inspection. Then log in as a
site-tied developer/contractor and confirm they can view the submitted
inspection's notes and photos (read-only — no edit/delete controls need to
be hidden for them specifically, since they simply can't reach this
in-progress-only form as a non-engineer to begin with; viewing happens via
whatever inspection-detail view already exists for completed inspections).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/pages/InspectionForm.tsx
git commit -m "feat: replace inspection checklist with rich-text notes and photo gallery"
```

---

## Self-Review Notes

- **Spec coverage:** Data model (design §1) — Task 1. Shared site-tie check (design §2) — Task 2. InspectionRequests roles/derivation/scoping (design §3) — Task 3. Inspections read-access broadening without touching write access (design §4, and the correction committed before this plan was written) — Task 4. Media read-access check (design §5) — Task 5. `usePermissions.ts` fix (design §6) — Task 6. `QuickActions.tsx` gating (design §7) — Task 7. Frontend types/media endpoints (design §8) — Task 8. `InspectionForm.tsx` rewrite (design §8) — Task 9. Testing approach (design §9) — every task's manual verification step.
- **Placeholder scan:** No "TBD"/"add validation" phrasing. Every code step has literal file contents. Task 9's note about `baseApi.ts`'s `prepareHeaders` is flagged as something to *check and fix inline if needed*, not deferred — it's not a placeholder, it's an explicit contingency because `fetchBaseQuery` behavior with `FormData` bodies can only be confirmed by reading that file at implementation time (already read during Spec 1 — it sets `Content-Type`/`Authorization`/`x-csrf-token` headers manually but never sets `Content-Type` unconditionally, so `FormData`'s browser-set boundary header should survive; still worth the explicit checkpoint since a wrong assumption here silently breaks uploads).
- **Type consistency check:** `SitesService.isTiedToSite(siteId, userId)` and `resolveTiedSiteIds(userId)` signatures (Task 2) are called identically in Tasks 3, 4, and 5. `MediaService.assertCanView(siteId, engineerId, user)`'s three-argument shape matches both its call sites in Task 5 exactly. `Inspection.notes`/`BackendInspection.notes` (Task 8) as `Record<string, unknown> | undefined`/`| null` matches what `InspectionForm.tsx` (Task 9) passes to `editor.commands.setContent(...)` and reads via `editor.getJSON()`. `UploadInspectionMediaPayload`'s field names (`inspectionId, file, latitude, longitude, caption?`) match exactly what Task 9's `handleFileSelected` constructs.
