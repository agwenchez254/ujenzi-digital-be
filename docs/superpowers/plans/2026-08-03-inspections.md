# Inspections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `Inspections` module — starting an inspection from an accepted `InspectionRequest` (with geofence enforcement), saving checklist progress, and submitting a finished inspection (which completes the parent request) — all inside the same NestJS + Prisma app as the previous two slices.

**Architecture:** One new module (`InspectionsModule`), same DTO + Service + Controller + Module shape as `Sites`/`InspectionRequests`. `InspectionsService` imports `SitesModule` to call the existing `SitesService.isWithinGeofence()` helper (built in the previous slice, unused until now). The `Inspection` write and its parent `InspectionRequest` status update happen inside a single `prisma.$transaction([...])` (array form, matching `UsersService.updateRoles`'s existing convention) so the two rows never drift out of sync.

**Tech Stack:** NestJS 11, Prisma (no schema migration this pass), `@nestjs/swagger`, `class-validator`/`class-transformer` (all already installed). Package manager is **pnpm**.

## Global Constraints

- No automated tests in this pass (matches the rest of the project). Every task substitutes a manual verification step (build + `pnpm run start:dev` + `curl`) for the usual test-first cycle.
- No Prisma schema migration. `Inspection`, `InspectionRequest`, and `Site` already have every field this module needs.
- Global `JwtAuthGuard` + `RolesGuard` guard every route by default; `@Roles('engineer', 'administrator')` narrows by role, ownership/state checks happen inside the service method — same pattern as `SitesService`/`InspectionRequestsService`.
- Every mutation (`create`/`update`/`submit`) calls `AuditLogService.log(userId, action, entityType, entityId, details?, ipAddress?)` — exact signature already defined in `src/audit-log/audit-log.service.ts`.
- Types used only in `@CurrentUser()`-decorated controller parameters must be imported with `import type` (not a plain `import`) — this project has `isolatedModules` + `emitDecoratorMetadata` enabled, and a plain `import { AuthenticatedUser } from '...'` used only in a decorated parameter position fails the build with TS1272. Every existing controller (`UsersController`, `SitesController`, `InspectionRequestsController`) already does this correctly; match it from the start.
- Swagger/OpenAPI decorators (`@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, `@ApiProperty`/`@ApiPropertyOptional`) go directly on the new controller/DTOs, consistent with the Sites/InspectionRequests slice — no retroactive work needed elsewhere.
- Package manager is `pnpm`, not `npm`/`yarn`.

---

## File Structure

```
src/
  app.module.ts                                  (modify: import InspectionsModule)
  inspections/
    dto/checklist-response-item.dto.ts           (create)
    dto/create-inspection.dto.ts                 (create)
    dto/update-inspection.dto.ts                  (create)
    dto/submit-inspection.dto.ts                  (create)
    inspections.service.ts                        (create)
    inspections.controller.ts                     (create)
    inspections.module.ts                         (create)
```

---

### Task 1: Inspections module

**Files:**
- Create: `src/inspections/dto/checklist-response-item.dto.ts`
- Create: `src/inspections/dto/create-inspection.dto.ts`
- Create: `src/inspections/dto/update-inspection.dto.ts`
- Create: `src/inspections/dto/submit-inspection.dto.ts`
- Create: `src/inspections/inspections.service.ts`
- Create: `src/inspections/inspections.controller.ts`
- Create: `src/inspections/inspections.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `AuditLogService.log(...)`, `AuthenticatedUser`, `@Roles()`/`@CurrentUser()` (all existing). `SitesService.isWithinGeofence(lat: number, lon: number, site: Site): boolean` (existing, exported from `SitesModule` — `src/sites/sites.service.ts:75`).
- Produces: `GET /inspections`, `GET /inspections/:id`, `POST /inspections`, `PATCH /inspections/:id`, `POST /inspections/:id/submit`.

- [x] **Step 1: Write `ChecklistResponseItemDto`**

`src/inspections/dto/checklist-response-item.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ChecklistResponseItemDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  question: string;

  @ApiProperty()
  @IsString()
  category: string;

  @ApiProperty()
  @IsString()
  response: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
```

- [x] **Step 2: Write `CreateInspectionDto`**

`src/inspections/dto/create-inspection.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsUUID } from 'class-validator';

export class CreateInspectionDto {
  @ApiProperty({ format: 'uuid', description: 'The accepted InspectionRequest to start.' })
  @IsUUID()
  requestId: string;

  @ApiProperty({ example: -1.2921, description: "The engineer's current latitude, checked against the site's geofence." })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 36.8219 })
  @IsLongitude()
  longitude: number;
}
```

- [x] **Step 3: Write `UpdateInspectionDto`**

`src/inspections/dto/update-inspection.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { RiskLevel } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ChecklistResponseItemDto } from './checklist-response-item.dto';

export class UpdateInspectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  observations?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  recommendations?: string;

  @ApiPropertyOptional({ enum: RiskLevel })
  @IsOptional()
  @IsEnum(RiskLevel)
  riskLevel?: RiskLevel;

  @ApiPropertyOptional({
    type: [ChecklistResponseItemDto],
    description: 'Replaces the entire checklist array — there is no item-level merge.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistResponseItemDto)
  checklistResponses?: ChecklistResponseItemDto[];
}
```

- [x] **Step 4: Write `SubmitInspectionDto`**

`src/inspections/dto/submit-inspection.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude } from 'class-validator';
import { UpdateInspectionDto } from './update-inspection.dto';

export class SubmitInspectionDto extends UpdateInspectionDto {
  @ApiProperty({ example: -1.2921, description: "The engineer's current latitude, checked against the site's geofence." })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 36.8219 })
  @IsLongitude()
  longitude: number;
}
```

- [x] **Step 5: Write `InspectionsService`**

`src/inspections/inspections.service.ts`:

```typescript
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Inspection, Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { SubmitInspectionDto } from './dto/submit-inspection.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';

const INSPECTION_INCLUDE = {
  site: { select: { id: true, name: true, address: true } },
  engineer: { select: { id: true, name: true } },
} as const;

@Injectable()
export class InspectionsService {
  constructor(
    private prisma: PrismaService,
    private sitesService: SitesService,
    private auditLogService: AuditLogService,
  ) {}

  findAll() {
    return this.prisma.inspection.findMany({
      include: INSPECTION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.findInspectionOrThrow(id);
  }

  async create(dto: CreateInspectionDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.prisma.inspectionRequest.findUnique({
      where: { id: dto.requestId },
      include: { site: true },
    });
    if (!request) {
      throw new NotFoundException('Inspection request not found');
    }
    if (request.status !== 'accepted') {
      throw new ConflictException('Only an accepted request can be started');
    }
    this.assertAssignedEngineerOrAdmin(request.engineerId, user);
    this.assertWithinGeofence(dto.latitude, dto.longitude, request.site);

    // Accepted requests always have engineerId set (InspectionRequestsService.accept).
    const [inspection] = await this.prisma.$transaction([
      this.prisma.inspection.create({
        data: {
          requestId: request.id,
          siteId: request.siteId,
          engineerId: request.engineerId!,
          status: 'in_progress',
          startTime: new Date(),
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
        include: INSPECTION_INCLUDE,
      }),
      this.prisma.inspectionRequest.update({
        where: { id: request.id },
        data: { status: 'in_progress' },
      }),
    ]);

    await this.auditLogService.log(
      user.userId,
      'inspection.started',
      'Inspection',
      inspection.id,
      { requestId: request.id },
      ip,
    );

    return inspection;
  }

  async update(id: string, dto: UpdateInspectionDto, user: AuthenticatedUser, ip?: string) {
    const inspection = await this.findInspectionOrThrow(id);
    this.assertOwnerOrAdmin(inspection, user);
    this.assertInProgress(inspection);

    const updated = await this.prisma.inspection.update({
      where: { id },
      data: {
        notes: dto.notes,
        observations: dto.observations,
        recommendations: dto.recommendations,
        riskLevel: dto.riskLevel,
        checklistResponses: dto.checklistResponses,
      },
      include: INSPECTION_INCLUDE,
    });

    await this.auditLogService.log(user.userId, 'inspection.updated', 'Inspection', id, { ...dto }, ip);

    return updated;
  }

  async submit(id: string, dto: SubmitInspectionDto, user: AuthenticatedUser, ip?: string) {
    const inspection = await this.findInspectionOrThrow(id);
    this.assertOwnerOrAdmin(inspection, user);

    if (inspection.status !== 'in_progress') {
      throw new ConflictException('Only an in-progress inspection can be submitted');
    }

    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: inspection.siteId } });
    this.assertWithinGeofence(dto.latitude, dto.longitude, site);

    const [updated] = await this.prisma.$transaction([
      this.prisma.inspection.update({
        where: { id },
        data: {
          notes: dto.notes,
          observations: dto.observations,
          recommendations: dto.recommendations,
          riskLevel: dto.riskLevel,
          checklistResponses: dto.checklistResponses,
          latitude: dto.latitude,
          longitude: dto.longitude,
          endTime: new Date(),
          status: 'submitted',
        },
        include: INSPECTION_INCLUDE,
      }),
      this.prisma.inspectionRequest.update({
        where: { id: inspection.requestId },
        data: { status: 'completed' },
      }),
    ]);

    await this.auditLogService.log(user.userId, 'inspection.submitted', 'Inspection', id, { ...dto }, ip);

    return updated;
  }

  private assertAssignedEngineerOrAdmin(engineerId: string | null, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    if (engineerId !== user.userId) {
      throw new ForbiddenException('Only the assigned engineer can start this inspection');
    }
  }

  private assertOwnerOrAdmin(inspection: Inspection, user: AuthenticatedUser) {
    if (inspection.engineerId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException('You do not own this inspection');
    }
  }

  private assertInProgress(inspection: Inspection) {
    if (inspection.status !== 'in_progress') {
      throw new ForbiddenException('This inspection can no longer be edited');
    }
  }

  private assertWithinGeofence(lat: number, lon: number, site: Site) {
    if (!this.sitesService.isWithinGeofence(lat, lon, site)) {
      throw new ForbiddenException("Outside the site's geofence");
    }
  }

  private async findInspectionOrThrow(id: string) {
    const inspection = await this.prisma.inspection.findUnique({
      where: { id },
      include: INSPECTION_INCLUDE,
    });
    if (!inspection) {
      throw new NotFoundException('Inspection not found');
    }
    return inspection;
  }
}
```

- [x] **Step 6: Write `InspectionsController`**

`src/inspections/inspections.controller.ts`:

```typescript
import { Body, Controller, Get, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { SubmitInspectionDto } from './dto/submit-inspection.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { InspectionsService } from './inspections.service';

@ApiTags('Inspections')
@ApiBearerAuth()
@Controller('inspections')
export class InspectionsController {
  constructor(private inspectionsService: InspectionsService) {}

  @ApiOperation({ summary: 'List all inspections' })
  @Get()
  findAll() {
    return this.inspectionsService.findAll();
  }

  @ApiOperation({ summary: 'Get an inspection by id' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.inspectionsService.findOne(id);
  }

  @ApiOperation({ summary: 'Start an inspection from an accepted request (assigned engineer or administrator)' })
  @Roles('engineer', 'administrator')
  @Post()
  create(@Body() dto: CreateInspectionDto, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.inspectionsService.create(dto, user, ip);
  }

  @ApiOperation({ summary: 'Save checklist progress on an in-progress inspection (owning engineer or administrator)' })
  @Roles('engineer', 'administrator')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInspectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionsService.update(id, dto, user, ip);
  }

  @ApiOperation({ summary: 'Submit a finished inspection and complete its inspection request' })
  @Roles('engineer', 'administrator')
  @Post(':id/submit')
  submit(
    @Param('id') id: string,
    @Body() dto: SubmitInspectionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionsService.submit(id, dto, user, ip);
  }
}
```

- [x] **Step 7: Write `InspectionsModule`**

`src/inspections/inspections.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SitesModule } from '../sites/sites.module';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';

@Module({
  imports: [AuditLogModule, SitesModule],
  controllers: [InspectionsController],
  providers: [InspectionsService],
})
export class InspectionsModule {}
```

- [x] **Step 8: Wire `InspectionsModule` into `AppModule`**

Modify `src/app.module.ts` — add the import and add `InspectionsModule` to the `imports` array (alphabetically, after `InspectionRequestsModule` and before `PrismaModule`):

```typescript
import { InspectionRequestsModule } from './inspection-requests/inspection-requests.module';
import { InspectionsModule } from './inspections/inspections.module';
// ...
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    PrismaModule,
    CommonModule,
    AuditLogModule,
    AuthModule,
    InspectionRequestsModule,
    InspectionsModule,
    SitesModule,
    UsersModule,
  ],
  // ...controllers/providers unchanged
})
```

- [x] **Step 9: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

- [x] **Step 10: Manually verify the full start → save → submit lifecycle, including geofence enforcement**

```bash
# Fresh contractor, assigned engineer, and an unrelated second engineer
curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"insp-contractor@example.com","password":"password123","name":"Insp Contractor","roles":["contractor"]}'
# Copy accessToken into $CONTRACTOR_TOKEN

curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"insp-engineer@example.com","password":"password123","name":"Insp Engineer","roles":["engineer"]}'
# Copy accessToken into $ENGINEER_TOKEN

curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"insp-other-engineer@example.com","password":"password123","name":"Other Engineer","roles":["engineer"]}'
# Copy accessToken into $OTHER_ENGINEER_TOKEN
```

```bash
# Site at (-1.28, 36.81) with the default 100m geofence, a request, and acceptance
curl -s -X POST http://localhost:5000/sites -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Inspection Test Site","latitude":-1.28,"longitude":36.81,"address":"1 Test Way"}'
# Copy the site id into $SITE_ID

curl -s -X POST http://localhost:5000/inspection-requests -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":\"$SITE_ID\",\"requestedDate\":\"2026-08-25\"}"
# Copy the request id into $REQUEST_ID

curl -s -X POST http://localhost:5000/inspection-requests/$REQUEST_ID/accept -H "Authorization: Bearer $ENGINEER_TOKEN"
```

Expected: the accept response shows `status: "accepted"` and `engineer.name: "Insp Engineer"`.

```bash
# The unrelated engineer cannot start it (403)
curl -s -w '\n%{http_code}\n' -X POST http://localhost:5000/inspections -H "Authorization: Bearer $OTHER_ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQUEST_ID\",\"latitude\":-1.28,\"longitude\":36.81}"
```

Expected: `403 Forbidden`.

```bash
# Starting far outside the geofence fails (403) — offset by ~1.1km, well past the 100m default radius
curl -s -w '\n%{http_code}\n' -X POST http://localhost:5000/inspections -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQUEST_ID\",\"latitude\":-1.29,\"longitude\":36.81}"
```

Expected: `403 Forbidden`, message mentions the geofence.

```bash
# The assigned engineer starts it at the site's exact coordinates
START_RESP=$(curl -s -X POST http://localhost:5000/inspections -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQUEST_ID\",\"latitude\":-1.28,\"longitude\":36.81}")
echo "$START_RESP"
# Copy the inspection id into $INSPECTION_ID
```

Expected: `201 Created`, `status: "in_progress"`, `engineer.name: "Insp Engineer"`.

```bash
# The parent request is now in_progress
curl -s http://localhost:5000/inspection-requests/$REQUEST_ID -H "Authorization: Bearer $ENGINEER_TOKEN"
```

Expected: `status: "in_progress"`.

```bash
# Starting the same request again fails (409) — no longer accepted
curl -s -w '\n%{http_code}\n' -X POST http://localhost:5000/inspections -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"requestId\":\"$REQUEST_ID\",\"latitude\":-1.28,\"longitude\":36.81}"
```

Expected: `409 Conflict`.

```bash
# Save checklist progress
curl -s -w '\n%{http_code}\n' -X PATCH http://localhost:5000/inspections/$INSPECTION_ID -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"notes":"Looks solid so far","checklistResponses":[{"id":"1","question":"Foundation poured?","category":"structural","response":"yes"}]}'
```

Expected: `200 OK`, `notes: "Looks solid so far"`, `checklistResponses` echoes the array back.

```bash
# Submitting outside the geofence fails (403)
curl -s -w '\n%{http_code}\n' -X POST http://localhost:5000/inspections/$INSPECTION_ID/submit -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"latitude":-1.29,"longitude":36.81,"riskLevel":"low"}'
```

Expected: `403 Forbidden`.

```bash
# Submitting at the site's coordinates succeeds
curl -s -w '\n%{http_code}\n' -X POST http://localhost:5000/inspections/$INSPECTION_ID/submit -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"latitude":-1.28,"longitude":36.81,"riskLevel":"low","recommendations":"None"}'
```

Expected: `200 OK`, `status: "submitted"`, `riskLevel: "low"`, `endTime` is set.

```bash
# The parent request is now completed
curl -s http://localhost:5000/inspection-requests/$REQUEST_ID -H "Authorization: Bearer $ENGINEER_TOKEN"
```

Expected: `status: "completed"`.

```bash
# Further edits/submits are rejected now that it's submitted
curl -s -w '\n%{http_code}\n' -X PATCH http://localhost:5000/inspections/$INSPECTION_ID -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"notes":"trying to edit after submit"}'
curl -s -w '\n%{http_code}\n' -X POST http://localhost:5000/inspections/$INSPECTION_ID/submit -H "Authorization: Bearer $ENGINEER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"latitude":-1.28,"longitude":36.81}'
```

Expected: PATCH returns `403 Forbidden`; submit returns `409 Conflict`. Stop the dev server.

- [x] **Step 11: Verify Swagger picked up the new routes**

```bash
curl -s http://localhost:5000/docs-json | grep -o '"/inspections[^"]*"' | sort -u
```

Expected: `/inspections`, `/inspections/{id}`, `/inspections/{id}/submit`.

- [x] **Step 12: Commit**

```bash
git add src/inspections src/app.module.ts
git commit -m "feat: add Inspections module with geofenced start/submit lifecycle"
```

---

## Self-Review Notes

- Spec coverage: Data model (design §1, no changes) — confirmed, no migration task needed. Endpoints + business rules (§2-3) — Task 1's service/controller. DTOs (§4) — Task 1 Steps 1-4. Swagger (§5) — inline in Task 1's controller/DTOs. The `checklistResponses` whole-array-replace note (§4) is reflected in `UpdateInspectionDto`'s `@ApiPropertyOptional` description and in the service simply assigning `dto.checklistResponses` outright (no merge logic).
- No placeholders: every step has literal file contents and literal curl verification commands.
- Type consistency check: `SitesService.isWithinGeofence(lat: number, lon: number, site: Site): boolean` (existing, `src/sites/sites.service.ts:75`) is called with the exact same argument order and `Site` type in both `create()` and `submit()`. `AuthenticatedUser` is imported with `import type` in the controller (matching the `isolatedModules` constraint noted above) and as a plain `import` in the service (where it's only used as a parameter type on non-decorated methods, matching `SitesService`'s and `InspectionRequestsService`'s existing style). `AuditLogService.log(...)`'s 6-argument signature matches every call site.
