# Core Data Model & Roles design

Date: 2026-08-12

## Purpose

Spec 1 of a 6-spec sequence (SiteSight Pro / Ujenzi Digital feature program):
Core Data Model & Roles → Realtime Infrastructure → Inspection Redesign →
Site Registration Modal port → Map Views & Sharing → Offline Support. Every
later spec depends on this one, since it changes `AppRole`, `Site`, and adds
`SitePersonnel` — the foundation the request/inspection permission model, the
site-registration form, and the map/PostGIS features all build on.

This slice does **not** touch `InspectionRequest`, `Inspection`, `Media`,
realtime, offline, or the frontend modal port — those are later specs. The
one frontend touch here is a single default-value bump in `sitesight-pro`'s
existing `SiteCreate.tsx`, kept in sync with the new backend default so the
two repos don't drift out of step between now and Spec 4 (the full modal
port).

## 1. Roles

Add `developer` to `AppRole`. `site_representative` is kept as a distinct
role (developer's on-site delegate) rather than merged/aliased.

```prisma
enum AppRole {
  engineer
  contractor
  site_representative
  administrator
  developer   // NEW
}
```

`UserRole` (existing join table, one row per user-role pair) needs no
structural change — `developer` is just a new valid value for its `role`
column. No migration risk here: adding an enum value is additive.

## 2. Site model extensions

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

model Site {
  id                String   @id @default(uuid())
  name              String
  contractorId      String                        // unchanged: primary contractor FK, kept for backward compat
  latitude          Decimal  @db.Decimal(10, 8)
  longitude         Decimal  @db.Decimal(11, 8)
  location          Unsupported("geography(Point,4326)")?   // NEW, see §3
  geofenceRadius    Int      @default(500)         // was 100
  address           String
  constructionPhase String?
  status            String   @default("active")
  developmentType   DevelopmentType?               // NEW
  country           String?                        // NEW
  county            String?                        // NEW
  constituency      String?                        // NEW
  town              String?                        // NEW
  plotNumber        String?                         // NEW
  landmarks         String[] @default([])           // NEW
  approvals         Json?                           // NEW, see below
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  contractor  User                @relation("ContractorSites", fields: [contractorId], references: [id])
  requests    InspectionRequest[]
  inspections Inspection[]
  personnel   SitePersonnel[]     // NEW
}

model SitePersonnel {
  id       String            @id @default(uuid())
  siteId   String
  role     SitePersonnelRole
  userId   String?                                 // set when linked to a real account
  name     String?                                  // set when freeform (no account)
  contact  String?                                  // phone/email, freeform case only

  site Site  @relation(fields: [siteId], references: [id], onDelete: Cascade)
  user User? @relation(fields: [userId], references: [id])

  @@index([siteId])
  @@index([userId])
}
```

`approvals` is a fixed-shape JSON blob (three known authorities, not an
open-ended list), matching the existing project convention of using `Json`
for fixed-shape structured data (`Inspection.checklistResponses`,
`InspectionTemplate.checklistItems`) rather than a relation table:

```json
{
  "county": { "status": "VALID | PENDING | EXPIRED", "reference": "string | null" },
  "nema":   { "status": "VALID | PENDING | EXPIRED", "reference": "string | null" },
  "nca":    { "status": "VALID | PENDING | EXPIRED", "reference": "string | null" }
}
```

`User` gains the corresponding back-relation, `sitePersonnel SitePersonnel[]`
(required by Prisma for any relation field — every other relation in this
schema already follows this pairing, e.g. `User.sitesOwned` ↔
`Site.contractor`).

`SitePersonnel` enforces "exactly one of `userId` / `name` is set" at the
DTO/service layer (`class-validator` custom validator), not a DB constraint —
consistent with how ownership checks elsewhere in this project live in the
service layer rather than the schema.

## 3. PostGIS

Prisma has no first-class geography type, so `latitude`/`longitude`
(`Decimal`) remain the source of truth for ordinary reads and writes — every
existing query, DTO, and the frontend's flat lat/lng fields keep working
unchanged. `location` is a derived column, kept in sync by a Postgres
trigger rather than application code, so no service method needs to
remember to update it:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE OR REPLACE FUNCTION sync_site_location() RETURNS trigger AS $$
BEGIN
  NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude::float8, NEW.latitude::float8), 4326)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER site_location_sync
  BEFORE INSERT OR UPDATE OF latitude, longitude ON "Site"
  FOR EACH ROW EXECUTE FUNCTION sync_site_location();

UPDATE "Site" SET latitude = latitude; -- fires the trigger once to backfill location on existing rows
```

Spatial reads (radius/geofence checks, "sites within viewport" for the
admin map in Spec 5) go through one new method,
`SitesService.findWithinRadius(lat, lon, radiusMeters)`, using `$queryRaw`
with `ST_DWithin` — the only place in the module that touches raw SQL. This
slice adds the method and its unit-level SQL only; nothing calls it yet
(mirrors how `isWithinGeofence` was added in the Sites+InspectionRequests
slice before anything called it — the Inspections module wires it up later).

Prisma's generated client can't type `Unsupported(...)` fields, so `location`
is excluded from `CreateSiteDto`/`UpdateSiteDto` entirely — it's
trigger-maintained, never set directly by the application.

## 4. Migration plan

One Prisma migration, run in this order:

1. `CREATE EXTENSION IF NOT EXISTS postgis;`
2. Add all new nullable `Site` columns (`developmentType`, `country`,
   `county`, `constituency`, `town`, `plotNumber`, `landmarks` default
   `[]`, `approvals`, `location`) — additive, no risk to existing rows.
3. Create `SitePersonnel` table.
4. Create the trigger function + trigger from §3, then backfill `location`
   for existing rows.
5. `ALTER TABLE "Site" ALTER COLUMN "geofenceRadius" SET DEFAULT 500;` then
   `UPDATE "Site" SET "geofenceRadius" = 500;` — unconditional backfill,
   overwriting any previously-customized per-site radius (explicit choice:
   existing sites get the new default too, not just new ones).

Since Prisma Migrate can't express raw SQL trigger/extension statements
declaratively, this migration is authored as a `prisma migrate dev --create-only`
skeleton with the trigger/extension/backfill SQL hand-added to the generated
`migration.sql`, matching how this project has handled any non-declarative
DDL so far (none yet — this is the first).

## 5. DTOs and service impact

`CreateSiteDto` gains: `developmentType?`, `country?`, `county?`,
`constituency?`, `town?`, `plotNumber?`, `landmarks?: string[]`,
`approvals?` (nested DTO with three optional `{status, reference}` blocks,
`status` validated via `@IsIn(['VALID','PENDING','EXPIRED'])`), `personnel?:
SitePersonnelInputDto[]` (each entry: `role`, and either `userId` or `name`
+ `contact`, validated with a custom `@ValidateIf`/cross-field check).
`UpdateSiteDto` mirrors the same optional fields minus `contractorId` (as
today).

`SitesService.create`/`update` gain personnel upsert logic: on create,
insert all `SitePersonnel` rows in the same transaction as the `Site` insert;
on update, replace the full personnel set (delete-then-recreate) rather than
diffing individual rows — simplest correct behavior for a form that always
submits the complete personnel list, matching the portal modal's UX (it's a
full `useFieldArray`, not incremental add/remove against the server).

No route table changes — `GET/POST/PATCH/DELETE /sites` keep their existing
access rules from the Sites+InspectionRequests slice; `developer` and
`site_representative` are added to the read-access set (already "any
authenticated user" per the existing table, so no change there) and are
folded into the same "administrator or the record's own developer/site-rep/
contractor" ownership pattern for anything ownership-scoped — deferred to
Spec 3 where the request-permission model is actually built, since this
slice only adds the *data*, not new endpoints or guard logic.

## 6. Frontend touch-point (sitesight-pro)

`src/pages/SiteCreate.tsx`: `geofence_radius` input default value
`"100"` → `"500"`, `min` stays `50`, `max` `1000` → `2000`. This is the
only frontend change in this spec — the full field set (`developmentType`,
personnel, approvals, etc.) arrives with the modal port in Spec 4. No other
sitesight-pro files change here; `usePermissions.ts`'s role list is
touched in Spec 3 alongside the dashboard `QuickActions` permission changes,
not here, since `developer` isn't yet wired into any permission check.

## 7. Testing

None in this pass, consistent with the rest of the project (per the
Sites+InspectionRequests slice, §6) — manual `curl`/`psql` verification:
confirm the migration applies cleanly against a copy of the existing dev
DB, confirm `location` populates for a freshly-inserted site and for a
backfilled existing one, confirm `ST_DWithin` returns expected rows for a
manual radius query, confirm `POST /sites` with a full `personnel` array
persists correctly and `GET /sites/:id` returns it nested.
