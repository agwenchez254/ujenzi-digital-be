# Core Data Model & Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `developer` role, extend `Site` with the fields needed to replicate the Ujenzi Digital Portal's site-registration form (development type, address hierarchy, landmarks, approvals, personnel roster), add a PostGIS-backed `location` column kept in sync via trigger, and bump the geofence default from 100m to 500m (backfilling existing sites).

**Architecture:** Same shape as every existing module in this codebase (DTO + Service + Controller, ownership checks in the service layer). This slice only touches the `Sites` module's DTOs/service — no new modules, no route changes. The one exception to "pure Prisma" is `Site.location`: Prisma has no geography type, so it's declared `Unsupported(...)`, populated by a hand-written Postgres trigger, and read only through one raw-SQL service method reserved for later specs.

**Tech Stack:** NestJS 11, Prisma 6, PostGIS (via a `postgis/postgis` Docker image swap), `class-validator`/`class-transformer` (already installed). Package manager is **pnpm**.

## Global Constraints

- No automated tests in this pass (matches the rest of the project — design spec §7, and every prior plan in `docs/superpowers/plans/`). Every task substitutes a manual verification step (build + `pnpm run start:dev` + `curl`/`psql`) for the usual test-first cycle.
- `site_representative` stays a distinct role from the new `developer` role — do not merge or alias them (design spec §1).
- `latitude`/`longitude` (`Decimal`) remain the source of truth for all application reads/writes. `location` (PostGIS geography) is trigger-maintained only — never set directly by DTOs or service code (design spec §3).
- `approvals` is a fixed-shape JSON blob (`county`/`nema`/`nca`, each `{status, reference}`), validated via nested DTOs with `class-validator`, not a relation table — matches the existing `Json`-for-fixed-shape-data convention (`Inspection.checklistResponses`, `InspectionTemplate.checklistItems`).
- `SitePersonnel.role` is a real Prisma enum (`SitePersonnelRole`); approval `status` values (`VALID`/`PENDING`/`EXPIRED`) are validated via `class-validator`'s `@IsIn(...)`, not a Prisma enum — matches how `Site.status` is validated today.
- A `PATCH /sites/:id` that includes `personnel` replaces the entire roster (delete-then-recreate); one that omits `personnel` leaves the existing roster untouched. Same "full replace, no item-level merge" semantics as `Inspection.checklistResponses`.
- No new routes and no `@Roles()` changes in this plan — `developer`/`site_representative` are added to the data model only. Wiring them into request/inspection permissions is a later spec (design spec §5).
- Package manager is `pnpm`, not `npm`/`yarn`.

---

## File Structure

```
docker-compose.yml                                                    (modify: Postgres image -> PostGIS-enabled image)
prisma/schema.prisma                                                  (modify: developer role, new enums, Site fields, SitePersonnel model, User back-relation)
prisma/migrations/<timestamp>_site_registration_fields_and_personnel/migration.sql   (create: generated, then hand-edited)
src/sites/dto/approval-status.dto.ts                                  (create)
src/sites/dto/site-approvals.dto.ts                                   (create)
src/sites/dto/site-personnel-input.dto.ts                             (create)
src/sites/dto/create-site.dto.ts                                      (modify)
src/sites/sites.service.ts                                            (modify)
```

No changes needed to `src/sites/dto/update-site.dto.ts` (it's `PartialType(OmitType(CreateSiteDto, ['contractorId']))`, so it inherits every new field automatically), `src/sites/sites.controller.ts`, `src/sites/sites.module.ts`, or `src/app.module.ts`.

sitesight-pro (separate repo, `C:\Users\Administrator\Desktop\Projects\sitesight-pro`):
```
src/pages/SiteCreate.tsx                                              (modify: geofence radius default/min/max)
```

---

### Task 1: Enable PostGIS on the local Postgres

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a running Postgres instance with the `postgis` extension installable. Task 2 depends on this — its migration runs `CREATE EXTENSION IF NOT EXISTS postgis;`, which fails on a plain `postgres:16-alpine` image (no PostGIS binaries).

- [ ] **Step 1: Swap the Postgres image**

Edit `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgis/postgis:16-3.4
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ujenzi_digital
    ports:
      - '5433:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

(Only the `image:` line changes — same Postgres major version, so the existing `postgres_data` volume stays compatible; no data loss.)

- [ ] **Step 2: Recreate the container with the new image**

```bash
docker compose down
docker compose up -d
```

- [ ] **Step 3: Verify the extension can be created**

```bash
docker compose exec postgres psql -U postgres -d ujenzi_digital -c "CREATE EXTENSION IF NOT EXISTS postgis; SELECT postgis_version();"
```

Expected: prints a PostGIS version string (e.g. `3.4 ...`), no errors.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: switch local Postgres to a PostGIS-enabled image"
```

---

### Task 2: Prisma schema — developer role, Site fields, SitePersonnel, PostGIS location

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_site_registration_fields_and_personnel/migration.sql` (generated by Prisma, then hand-edited)

**Interfaces:**
- Consumes: the PostGIS-enabled Postgres from Task 1.
- Produces: `AppRole.developer`, `DevelopmentType` enum, `SitePersonnelRole` enum, the new `Site` columns (`developmentType`, `country`, `county`, `constituency`, `town`, `plotNumber`, `landmarks`, `approvals`, `location`, `geofenceRadius` default `500`), the `SitePersonnel` model, and `User.sitePersonnel`. Task 3's DTOs and service reference every one of these names exactly.

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Add `developer` to `AppRole`:

```prisma
enum AppRole {
  engineer
  contractor
  site_representative
  administrator
  developer
}
```

Add two new enums (place after `RiskLevel`):

```prisma
enum DevelopmentType {
  RESIDENTIAL
  COMMERCIAL
  INDUSTRIAL
  MIXED_USE
  INSTITUTIONAL
}

enum SitePersonnelRole {
  DEVELOPER
  SITE_REPRESENTATIVE
  CONTRACTOR
  QUANTITY_SURVEYOR
  ENGINEER
}
```

Add `sitePersonnel SitePersonnel[]` to `User`'s relations block (alongside the existing `auditLogs AuditLog[]` line):

```prisma
model User {
  // ...existing fields unchanged...

  roles            UserRole[]
  refreshTokens    RefreshToken[]
  sitesOwned       Site[]              @relation("ContractorSites")
  requestsMade     InspectionRequest[] @relation("ContractorRequests")
  requestsAssigned InspectionRequest[] @relation("EngineerRequests")
  inspections      Inspection[]
  auditLogs        AuditLog[]
  sitePersonnel    SitePersonnel[]
}
```

Replace the `Site` model with:

```prisma
model Site {
  id                String           @id @default(uuid())
  name              String
  contractorId      String
  latitude          Decimal          @db.Decimal(10, 8)
  longitude         Decimal          @db.Decimal(11, 8)
  location          Unsupported("geography(Point,4326)")?
  geofenceRadius    Int              @default(500)
  address           String
  constructionPhase String?
  status            String           @default("active") // active | inactive
  developmentType   DevelopmentType?
  country           String?
  county            String?
  constituency      String?
  town              String?
  plotNumber        String?
  landmarks         String[]         @default([])
  approvals         Json?
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt

  contractor  User                @relation("ContractorSites", fields: [contractorId], references: [id])
  requests    InspectionRequest[]
  inspections Inspection[]
  personnel   SitePersonnel[]
}
```

Add a new `SitePersonnel` model (place immediately after `Site`):

```prisma
model SitePersonnel {
  id      String            @id @default(uuid())
  siteId  String
  role    SitePersonnelRole
  userId  String?
  name    String?
  contact String?

  site Site  @relation(fields: [siteId], references: [id], onDelete: Cascade)
  user User? @relation(fields: [userId], references: [id])

  @@index([siteId])
  @@index([userId])
}
```

- [ ] **Step 2: Generate the migration without applying it**

```bash
pnpm prisma migrate dev --name site_registration_fields_and_personnel --create-only
```

This creates `prisma/migrations/<timestamp>_site_registration_fields_and_personnel/migration.sql`. Open that file — it's the only new folder under `prisma/migrations/`.

- [ ] **Step 3: Hand-edit the generated migration.sql**

Insert this as the **very first line** of the file (before anything Prisma generated — the `location` column's `geography(Point,4326)` type doesn't exist until this runs):

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

Append this block at the **very end** of the file:

```sql
-- Keep Site.location in sync with latitude/longitude automatically.
CREATE OR REPLACE FUNCTION sync_site_location() RETURNS trigger AS $$
BEGIN
  NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude::float8, NEW.latitude::float8), 4326)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER site_location_sync
  BEFORE INSERT OR UPDATE OF latitude, longitude ON "Site"
  FOR EACH ROW EXECUTE FUNCTION sync_site_location();

-- Backfill location for every existing row (no-op update fires the trigger above).
UPDATE "Site" SET latitude = latitude;

-- Backfill the new default radius onto every existing site too (explicit product decision,
-- not just new sites going forward).
UPDATE "Site" SET "geofenceRadius" = 500;
```

- [ ] **Step 4: Apply the migration and regenerate the client**

```bash
pnpm prisma migrate dev
```

Expected: reports the pending migration as already created and applies it cleanly (no further schema drift detected), then regenerates the Prisma client.

- [ ] **Step 5: Verify with psql**

```bash
docker compose exec postgres psql -U postgres -d ujenzi_digital -c "\d \"Site\""
docker compose exec postgres psql -U postgres -d ujenzi_digital -c "SELECT id, \"geofenceRadius\", ST_AsText(location) FROM \"Site\" LIMIT 5;"
```

Expected: the first command's column list includes `location`, `developmentType`, `country`, `county`, `constituency`, `town`, `plotNumber`, `landmarks`, `approvals`; the second shows `geofenceRadius = 500` and a populated `POINT(...)` value for every pre-existing site (empty result set is fine if there were no sites yet).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add developer role, site registration fields, SitePersonnel, PostGIS location"
```

---

### Task 3: Site DTOs, personnel/approvals handling, spatial query method

**Files:**
- Create: `src/sites/dto/approval-status.dto.ts`
- Create: `src/sites/dto/site-approvals.dto.ts`
- Create: `src/sites/dto/site-personnel-input.dto.ts`
- Modify: `src/sites/dto/create-site.dto.ts`
- Modify: `src/sites/sites.service.ts`

**Interfaces:**
- Consumes: `DevelopmentType`, `SitePersonnelRole` (Task 2, via `@prisma/client`), existing `PrismaService`/`AuditLogService`/`AuthenticatedUser`.
- Produces: `CreateSiteDto` (and, transitively, `UpdateSiteDto`) gain `developmentType?`, `country?`, `county?`, `constituency?`, `town?`, `plotNumber?`, `landmarks?: string[]`, `approvals?: SiteApprovalsDto`, `personnel?: SitePersonnelInputDto[]`. `SitesService.findWithinRadius(lat: number, lon: number, radiusMeters: number): Promise<SiteWithinRadiusRow[]>` — new, exported, not called anywhere yet (reserved for the Map Views spec, same pattern as the existing unused `isWithinGeofence`).

- [ ] **Step 1: Write `ApprovalStatusDto`**

`src/sites/dto/approval-status.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export const APPROVAL_STATUSES = ['VALID', 'PENDING', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export class ApprovalStatusDto {
  @ApiProperty({ enum: APPROVAL_STATUSES })
  @IsIn(APPROVAL_STATUSES)
  status: ApprovalStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;
}
```

- [ ] **Step 2: Write `SiteApprovalsDto`**

`src/sites/dto/site-approvals.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { ApprovalStatusDto } from './approval-status.dto';

export class SiteApprovalsDto {
  @ApiPropertyOptional({ type: ApprovalStatusDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalStatusDto)
  county?: ApprovalStatusDto;

  @ApiPropertyOptional({ type: ApprovalStatusDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalStatusDto)
  nema?: ApprovalStatusDto;

  @ApiPropertyOptional({ type: ApprovalStatusDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApprovalStatusDto)
  nca?: ApprovalStatusDto;
}
```

- [ ] **Step 3: Write `SitePersonnelInputDto`**

`src/sites/dto/site-personnel-input.dto.ts`. The cross-field "exactly one of `userId`/`name`" check is attached to `role` (always required, never skipped by `@IsOptional`) rather than to `userId` or `name` themselves — a custom validator on an optional field would be silently skipped by `class-validator` whenever that field is `undefined`, which is exactly the case we need to catch (neither provided):

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SitePersonnelRole } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'exactlyOneOfUserIdOrName' })
class ExactlyOneOfUserIdOrNameConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as SitePersonnelInputDto;
    return Boolean(dto.userId) !== Boolean(dto.name);
  }

  defaultMessage(): string {
    return 'Provide exactly one of userId (linked account) or name (freeform contact)';
  }
}

export class SitePersonnelInputDto {
  @ApiProperty({ enum: SitePersonnelRole })
  @IsEnum(SitePersonnelRole)
  @Validate(ExactlyOneOfUserIdOrNameConstraint)
  role: SitePersonnelRole;

  @ApiPropertyOptional({ format: 'uuid', description: 'Set when this person has a registered account.' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Set when this person has no account (e.g. a quantity surveyor referenced for records only).',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Phone/email — only meaningful alongside name (freeform contact).' })
  @IsOptional()
  @IsString()
  contact?: string;
}
```

- [ ] **Step 4: Rewrite `CreateSiteDto`**

`src/sites/dto/create-site.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DevelopmentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { SiteApprovalsDto } from './site-approvals.dto';
import { SitePersonnelInputDto } from './site-personnel-input.dto';

export class CreateSiteDto {
  @ApiProperty({ example: 'Riverside Towers' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description:
      'Administrator only — the contractor to create this site for. Ignored/forbidden for contractor callers, who always create for themselves.',
  })
  @IsOptional()
  @IsUUID()
  contractorId?: string;

  @ApiProperty({ example: -1.2921 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 36.8219 })
  @IsLongitude()
  longitude: number;

  @ApiPropertyOptional({
    example: 500,
    default: 500,
    description: 'Meters. Defaults to 500 in the database if omitted.',
  })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2000)
  geofenceRadius?: number;

  @ApiProperty({ example: '123 River Road, Nairobi' })
  @IsString()
  address: string;

  @ApiPropertyOptional({ example: 'Foundation' })
  @IsOptional()
  @IsString()
  constructionPhase?: string;

  @ApiPropertyOptional({ enum: DevelopmentType })
  @IsOptional()
  @IsEnum(DevelopmentType)
  developmentType?: DevelopmentType;

  @ApiPropertyOptional({ example: 'Kenya' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'Nairobi' })
  @IsOptional()
  @IsString()
  county?: string;

  @ApiPropertyOptional({ example: 'Westlands' })
  @IsOptional()
  @IsString()
  constituency?: string;

  @ApiPropertyOptional({ example: 'Nairobi' })
  @IsOptional()
  @IsString()
  town?: string;

  @ApiPropertyOptional({ example: 'LR 209/1234' })
  @IsOptional()
  @IsString()
  plotNumber?: string;

  @ApiPropertyOptional({ type: [String], example: ['Near Sarit Centre'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  landmarks?: string[];

  @ApiPropertyOptional({ type: SiteApprovalsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SiteApprovalsDto)
  approvals?: SiteApprovalsDto;

  @ApiPropertyOptional({
    type: [SitePersonnelInputDto],
    description: 'Replaces the entire personnel roster — there is no item-level merge.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SitePersonnelInputDto)
  personnel?: SitePersonnelInputDto[];
}
```

(`UpdateSiteDto` needs no edit — it derives every field above automatically via `PartialType(OmitType(CreateSiteDto, ['contractorId']))`.)

- [ ] **Step 5: Rewrite `SitesService`**

`src/sites/sites.service.ts`:

```typescript
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

const CONTRACTOR_SELECT = { id: true, name: true, company: true } as const;
const PERSONNEL_INCLUDE = {
  personnel: {
    include: { user: { select: { id: true, name: true, email: true } } },
  },
} as const;
const EARTH_RADIUS_METERS = 6_371_000;

export interface SiteWithinRadiusRow {
  id: string;
  name: string;
  address: string;
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
  geofenceRadius: number;
  distanceMeters: number;
}

@Injectable()
export class SitesService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
  ) {}

  findAll() {
    return this.prisma.site.findMany({
      include: { contractor: { select: CONTRACTOR_SELECT }, ...PERSONNEL_INCLUDE },
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.findSiteOrThrow(id);
  }

  async create(dto: CreateSiteDto, user: AuthenticatedUser, ip?: string) {
    const contractorId = this.resolveContractorId(dto.contractorId, user);

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

      return site;
    });

    await this.auditLogService.log(user.userId, 'site.created', 'Site', created.id, { contractorId }, ip);

    return this.findSiteOrThrow(created.id);
  }

  async update(id: string, dto: UpdateSiteDto, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    this.assertOwnerOrAdmin(site, user);

    await this.prisma.$transaction(async (tx) => {
      await tx.site.update({
        where: { id },
        data: {
          name: dto.name,
          latitude: dto.latitude,
          longitude: dto.longitude,
          geofenceRadius: dto.geofenceRadius,
          address: dto.address,
          constructionPhase: dto.constructionPhase,
          status: dto.status,
          developmentType: dto.developmentType,
          country: dto.country,
          county: dto.county,
          constituency: dto.constituency,
          town: dto.town,
          plotNumber: dto.plotNumber,
          landmarks: dto.landmarks,
          approvals: dto.approvals as unknown as Prisma.InputJsonValue | undefined,
        },
      });

      if (dto.personnel) {
        await tx.sitePersonnel.deleteMany({ where: { siteId: id } });
        if (dto.personnel.length) {
          await tx.sitePersonnel.createMany({
            data: dto.personnel.map((p) => ({
              siteId: id,
              role: p.role,
              userId: p.userId,
              name: p.name,
              contact: p.contact,
            })),
          });
        }
      }
    });

    await this.auditLogService.log(user.userId, 'site.updated', 'Site', id, { ...dto }, ip);

    return this.findSiteOrThrow(id);
  }

  async remove(id: string, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    this.assertOwnerOrAdmin(site, user);

    await this.prisma.site.delete({ where: { id } });

    await this.auditLogService.log(user.userId, 'site.deleted', 'Site', id, undefined, ip);
  }

  isWithinGeofence(lat: number, lon: number, site: Site): boolean {
    const radiusMeters = site.geofenceRadius ?? 500;
    const distanceMeters = this.haversineDistanceMeters(lat, lon, Number(site.latitude), Number(site.longitude));
    return distanceMeters <= radiusMeters;
  }

  findWithinRadius(lat: number, lon: number, radiusMeters: number) {
    return this.prisma.$queryRaw<SiteWithinRadiusRow[]>`
      SELECT
        id,
        name,
        address,
        latitude,
        longitude,
        "geofenceRadius",
        ST_Distance(location, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography) AS "distanceMeters"
      FROM "Site"
      WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${radiusMeters})
      ORDER BY "distanceMeters" ASC
    `;
  }

  private haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

    return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private resolveContractorId(dtoContractorId: string | undefined, user: AuthenticatedUser): string {
    const isAdmin = user.roles.includes('administrator');

    if (isAdmin) {
      if (!dtoContractorId) {
        throw new ForbiddenException('contractorId is required when an administrator creates a site');
      }
      return dtoContractorId;
    }

    if (dtoContractorId && dtoContractorId !== user.userId) {
      throw new ForbiddenException('Cannot create a site for another contractor');
    }

    return user.userId;
  }

  private assertOwnerOrAdmin(site: Site, user: AuthenticatedUser) {
    if (site.contractorId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException('You do not own this site');
    }
  }

  private async findSiteOrThrow(id: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      include: { contractor: { select: CONTRACTOR_SELECT }, ...PERSONNEL_INCLUDE },
    });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return site;
  }
}
```

- [ ] **Step 6: Build**

```bash
pnpm run build
```

Expected: compiles cleanly. If `DevelopmentType`/`SitePersonnelRole` aren't found on `@prisma/client`, re-run `pnpm prisma generate` (Task 2 Step 4 should already have done this).

- [ ] **Step 7: Run and manually verify the full field set**

```bash
pnpm run start:dev
```

```bash
# Reuse an existing contractor token, or sign one up:
curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"registration-contractor@example.com","password":"password123","name":"Registration Contractor","roles":["contractor"]}'
# Copy accessToken into $CONTRACTOR_TOKEN
```

```bash
curl -i -X POST http://localhost:3000/sites -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "Riverside Towers",
    "latitude": -1.2921,
    "longitude": 36.8219,
    "address": "123 River Road",
    "developmentType": "RESIDENTIAL",
    "country": "Kenya",
    "county": "Nairobi",
    "constituency": "Westlands",
    "town": "Nairobi",
    "plotNumber": "LR 209/1234",
    "landmarks": ["Near Sarit Centre"],
    "approvals": {
      "county": {"status": "VALID", "reference": "NCC/2026/001"},
      "nema": {"status": "PENDING"}
    },
    "personnel": [
      {"role": "CONTRACTOR", "userId": "'$CONTRACTOR_ID'"},
      {"role": "QUANTITY_SURVEYOR", "name": "Jane QS", "contact": "jane@example.com"}
    ]
  }'
```

Expected: `201 Created`. Response includes `geofenceRadius: 500` (omitted → default applied), the full `approvals` object, and nested `personnel: [...]` with two entries — one carrying `user: {name: "Registration Contractor", ...}`, the other carrying `name: "Jane QS", contact: "jane@example.com", user: null`. Copy the site id into `$SITE_ID`.

```bash
# Omitting userId AND name must fail validation
curl -i -X POST http://localhost:3000/sites -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Bad Site","latitude":-1.28,"longitude":36.81,"address":"x","personnel":[{"role":"ENGINEER"}]}'
```

Expected: `400 Bad Request` mentioning `exactlyOneOfUserIdOrName`.

```bash
# PATCH without "personnel" leaves the roster untouched
curl -i -X PATCH http://localhost:3000/sites/$SITE_ID -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"town":"Updated Town"}'
curl -s http://localhost:3000/sites/$SITE_ID -H "Authorization: Bearer $CONTRACTOR_TOKEN" | grep -o '"personnel":\[[^]]*\]' | head -c 200
```

Expected: `town` updated, `personnel` array still has both entries.

```bash
# PATCH with an empty "personnel" array clears the roster
curl -i -X PATCH http://localhost:3000/sites/$SITE_ID -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"personnel":[]}'
```

Expected: `200 OK`, `personnel: []`.

```bash
# Spatial query: findWithinRadius has no route yet, so verify it via psql directly
docker compose exec postgres psql -U postgres -d ujenzi_digital -c \
  "SELECT id, name, ST_Distance(location, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326)::geography) FROM \"Site\" WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326)::geography, 500);"
```

Expected: returns the Riverside Towers row with `distance` ≈ 0 (same coordinates used to create it). Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/sites
git commit -m "feat: add site registration fields, personnel roster, and spatial query method"
```

---

### Task 4: sitesight-pro geofence radius default bump

**Files:**
- Modify: `C:\Users\Administrator\Desktop\Projects\sitesight-pro\src\pages\SiteCreate.tsx`

**Interfaces:**
- Consumes: nothing new (this is a same-file default-value change).
- Produces: nothing consumed elsewhere in this plan. (The full field-set port of this form is a later spec — this task only keeps the one existing field's default in sync with the new backend default.)

- [ ] **Step 1: Update the default form state**

In `SiteCreate.tsx`, change:

```typescript
    geofence_radius: '100',
```

to:

```typescript
    geofence_radius: '500',
```

- [ ] **Step 2: Update the input's min/max and placeholder**

Change:

```tsx
                  id="radius"
                  type="number"
                  min="50"
                  max="1000"
                  placeholder="100"
```

to:

```tsx
                  id="radius"
                  type="number"
                  min="50"
                  max="2000"
                  placeholder="500"
```

- [ ] **Step 3: Run the dev server and manually verify**

```bash
cd "C:\Users\Administrator\Desktop\Projects\sitesight-pro"
npm run dev
```

Open the "Create Site" page in a browser. Expected: the radius field shows `500` pre-filled, and the input rejects values below `50` or above `2000`. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\Administrator\Desktop\Projects\sitesight-pro"
git add src/pages/SiteCreate.tsx
git commit -m "chore: bump default geofence radius to 500m"
```

---

## Self-Review Notes

- **Spec coverage:** Roles (design §1) — Task 2 Step 1. Site field extensions + `SitePersonnel` (design §2) — Task 2 Step 1, Task 3 Steps 1–5. PostGIS trigger + backfill (design §3) — Task 2 Steps 1–3. Migration plan/ordering (design §4) — Task 1 (extension prerequisite) + Task 2. DTO/service impact including personnel upsert semantics (design §5) — Task 3 Steps 4–5. Frontend touch-point (design §6) — Task 4. Testing approach (design §7, manual verification) — every task's verification step.
- **Placeholder scan:** No "TBD"/"add validation"/"similar to Task N" phrasing remains; every code step has literal file contents; the one inherently dynamic value (the generated migration folder's timestamp) is called out explicitly as dynamic rather than faked with a placeholder timestamp.
- **Type consistency check:** `SitesService.findSiteOrThrow`'s include shape (`contractor` + `personnel.user`) is used identically in `findAll`, `create`'s return, and `update`'s return. `SitePersonnelInputDto.role`/`userId`/`name`/`contact` field names match `SitesService`'s `tx.sitePersonnel.createMany` mapping exactly. `SiteWithinRadiusRow`'s fields match the raw SQL `SELECT` list exactly (including the quoted `"geofenceRadius"` and computed `"distanceMeters"` aliases). `ApprovalStatusDto`/`SiteApprovalsDto`/`SitePersonnelInputDto` are imported into `create-site.dto.ts` under the same names they're exported with, and `update-site.dto.ts` requires no changes since it derives from `CreateSiteDto` via `PartialType`/`OmitType`, confirmed against the actual current file content (read during planning) rather than assumed.
