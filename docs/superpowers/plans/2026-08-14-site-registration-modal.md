# Site Registration Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the portal's site-registration UX as a Dialog in sitesight-pro, against sitesight-pro's own stack and the backend's actual `Site`/`SitePersonnel` contract — not a literal port, since the portal's component matches neither on role vocabulary, personnel shape, payload shape, or tech stack. Add `developer`-can-register-sites support and wire up the previously-dead "Edit Site" button.

**Architecture:** One new backend field (`expectedEndDate`), one new backend endpoint (`GET /users/lookup`), widened role checks on `Site` write routes with a new `contractorId`-derivation path for developers, and a single controlled `SiteRegistrationDialog` component (split into three field sub-components for personnel/approvals/landmarks) used for both create and edit, triggered from two different parent pages.

**Tech Stack:** NestJS 11, Prisma 6 (plain column addition). Frontend: `react-hook-form` + `zod` + `@hookform/resolvers/zod` (all already installed, unused elsewhere in this codebase until now), existing Radix-based shadcn components (`Dialog`, `Form`, `Tabs`, `Select`).

## Global Constraints

- No automated tests in this pass, consistent with the rest of the project. Every task substitutes a manual verification step.
- `contractorId` on `Site` is set once at creation and is never modified by `update()` — confirmed from the current `sites.service.ts`. No task in this plan should add `contractorId` to the `update()` data block.
- `site_representative` is **not** added to any `Site` write-route role check in this spec — not requested, and would be scope creep beyond what was decided.
- `DELETE /sites/:id` role check is **not** touched — stays `('contractor', 'administrator')`. Only `POST /sites` and `PATCH /sites/:id` widen to include `developer`.
- The frontend `Site`/`CreateSitePayload`/`UpdateSitePayload` types keep the existing convention: top-level scalar fields are `snake_case` (matching existing siblings like `contractor_id`, `geofence_radius`, `construction_phase`), but the nested `approvals`/`personnel` structures keep their natural shape (e.g. `personnel[].userId`, not `personnel[].user_id`) — inventing a parallel snake_case mirror for nested object keys isn't worth the mapping complexity for structures that get round-tripped back to the API on every submit.
- Package manager is `pnpm` for `ujenzi-digital-be`, `npm` for `sitesight-pro`.

---

## File Structure

```
ujenzi-digital-be/
  prisma/schema.prisma                                    (modify: Site.expectedEndDate)
  prisma/migrations/<timestamp>_site_expected_end_date/   (create: generated)
  src/sites/dto/create-site.dto.ts                        (modify: add expectedEndDate)
  src/sites/sites.controller.ts                           (modify: widen @Roles on POST/PATCH)
  src/sites/sites.service.ts                              (modify: resolveContractorId, assertOwnerOrAdmin, expectedEndDate in create/update)
  src/users/dto/lookup-user.dto.ts                        (create)
  src/users/users.controller.ts                           (modify: add GET /users/lookup)
  src/users/users.service.ts                              (modify: add lookupByEmail)

sitesight-pro/
  src/hooks/usePermissions.ts                             (modify: developer gets create_sites/edit_sites)
  src/lib/kenyaCounties.ts                                (create)
  src/store/api/sitesApi.ts                               (modify: full field extension)
  src/store/api/usersApi.ts                               (modify: add lookupUserByEmail)
  src/components/sites/SiteLandmarksField.tsx             (create)
  src/components/sites/SiteApprovalsField.tsx             (create)
  src/components/sites/SitePersonnelField.tsx             (create)
  src/components/sites/SiteRegistrationDialog.tsx         (create)
  src/pages/Sites.tsx                                     (modify: Dialog instead of Link to /sites/new)
  src/pages/SiteDetail.tsx                                (modify: wire up Edit Site, fix ownership check)
  src/pages/SiteCreate.tsx                                (delete)
  src/App.tsx                                             (modify: remove /sites/new route)
```

---

### Task 1: Backend — `Site.expectedEndDate`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_site_expected_end_date/` (generated)
- Modify: `src/sites/dto/create-site.dto.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Site.expectedEndDate: Date | null` on the generated client; `CreateSiteDto.expectedEndDate?: string`. Task 2 depends on both.

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Add `expectedEndDate DateTime?` to the `Site` model, right after `plotNumber`:

```prisma
  plotNumber        String?
  expectedEndDate   DateTime?
  landmarks         String[]         @default([])
```

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm prisma migrate dev --name site_expected_end_date
```

- [ ] **Step 3: Add the field to `CreateSiteDto`**

Modify `src/sites/dto/create-site.dto.ts` — add the import and field (after `plotNumber`, before `landmarks`):

```typescript
import { IsDateString, /* ...existing imports... */ } from 'class-validator';
```

(merge into the existing `class-validator` import line rather than duplicating it)

```typescript
  @ApiPropertyOptional({ example: 'LR 209/1234' })
  @IsOptional()
  @IsString()
  plotNumber?: string;

  @ApiPropertyOptional({ example: '2027-06-30' })
  @IsOptional()
  @IsDateString()
  expectedEndDate?: string;

  @ApiPropertyOptional({ type: [String], example: ['Near Sarit Centre'] })
```

(`UpdateSiteDto` needs no edit — it derives every field from `CreateSiteDto` via `PartialType(OmitType(...))`.)

- [ ] **Step 4: Build and verify**

```bash
pnpm run build
docker compose exec postgres psql -U postgres -d ujenzi_digital -c "\d \"Site\""
```

Expected: build succeeds; column list includes `expectedEndDate` as `timestamp(3)`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/sites/dto/create-site.dto.ts
git commit -m "feat: add expectedEndDate to Site"
```

---

### Task 2: Backend — developer can register and edit sites

**Files:**
- Modify: `src/sites/sites.controller.ts`
- Modify: `src/sites/sites.service.ts`

**Interfaces:**
- Consumes: `CreateSiteDto.expectedEndDate` (Task 1), `SitePersonnelInputDto` (existing, from Spec 1).
- Produces: nothing new consumed elsewhere in this plan — Task 9's frontend work targets these routes by path/method, not by any TS type exported here.

- [ ] **Step 1: Widen `@Roles()` in `SitesController`**

Modify `src/sites/sites.controller.ts` — both `create` and `update` methods:

```typescript
  @ApiOperation({ summary: 'Create a site (contractor for self, developer via a linked contractor in personnel, or administrator for any contractor)' })
  @Roles('contractor', 'developer', 'administrator')
  @Post()
  create(@Body() dto: CreateSiteDto, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
```

```typescript
  @ApiOperation({ summary: 'Update a site (owning contractor, a linked developer, or administrator)' })
  @Roles('contractor', 'developer', 'administrator')
  @Patch(':id')
```

(Only the `@ApiOperation`/`@Roles` lines change; `DELETE` stays `@Roles('contractor', 'administrator')`, unchanged.)

- [ ] **Step 2: Rewrite `resolveContractorId` and its call site in `SitesService`**

Modify `src/sites/sites.service.ts` — add `BadRequestException` to the import:

```typescript
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
```

Replace `resolveContractorId` and its call in `create()`:

```typescript
  async create(dto: CreateSiteDto, user: AuthenticatedUser, ip?: string) {
    const contractorId = this.resolveContractorId(dto, user);
```

```typescript
  private resolveContractorId(dto: CreateSiteDto, user: AuthenticatedUser): string {
    if (user.roles.includes('administrator')) {
      if (!dto.contractorId) {
        throw new ForbiddenException('contractorId is required when an administrator creates a site');
      }
      return dto.contractorId;
    }

    if (user.roles.includes('contractor')) {
      if (dto.contractorId && dto.contractorId !== user.userId) {
        throw new ForbiddenException('Cannot create a site for another contractor');
      }
      return user.userId;
    }

    const contractorEntry = dto.personnel?.find((p) => p.role === 'CONTRACTOR' && p.userId);
    if (!contractorEntry?.userId) {
      throw new BadRequestException(
        'A contractor must be assigned via personnel (with a linked account) when registering a site as a developer',
      );
    }
    return contractorEntry.userId;
  }
```

- [ ] **Step 3: Add `expectedEndDate` to `create()`'s and `update()`'s data blocks**

In `create()`, inside the `tx.site.create({ data: {...} })` block, add after `plotNumber`:

```typescript
          plotNumber: dto.plotNumber,
          expectedEndDate: dto.expectedEndDate ? new Date(dto.expectedEndDate) : undefined,
          landmarks: dto.landmarks,
```

In `update()`, inside the `tx.site.update({ data: {...} })` block, same insertion:

```typescript
          plotNumber: dto.plotNumber,
          expectedEndDate: dto.expectedEndDate ? new Date(dto.expectedEndDate) : undefined,
          landmarks: dto.landmarks,
```

- [ ] **Step 4: Make `assertOwnerOrAdmin` async and broaden it**

Replace the method and update both call sites (`update()` and `remove()`) to `await` it:

```typescript
  private async assertOwnerOrAdmin(site: Site, user: AuthenticatedUser) {
    if (site.contractorId === user.userId || user.roles.includes('administrator')) {
      return;
    }
    const isLinkedDeveloper = await this.prisma.sitePersonnel.findFirst({
      where: { siteId: site.id, userId: user.userId, role: 'DEVELOPER' },
    });
    if (!isLinkedDeveloper) {
      throw new ForbiddenException('You do not own this site');
    }
  }
```

In `update()`: `this.assertOwnerOrAdmin(site, user);` → `await this.assertOwnerOrAdmin(site, user);`
In `remove()`: same change.

- [ ] **Step 5: Build**

```bash
pnpm run build
```

- [ ] **Step 6: Manually verify the developer-registers-a-site flow**

```bash
pnpm run start:dev
```

```bash
CONTRACTOR_SIGNUP=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"srm-contractor@example.com","password":"password123","name":"SRM Contractor","roles":["contractor"]}')
CONTRACTOR_TOKEN=$(echo "$CONTRACTOR_SIGNUP" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
CONTRACTOR_ID=$(echo "$CONTRACTOR_SIGNUP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

DEVELOPER_TOKEN=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"srm-developer@example.com","password":"password123","name":"SRM Developer","roles":["developer"]}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
```

```bash
# Developer without a linked-contractor personnel entry — expect 400
curl -i -X POST http://localhost:5000/sites -H "Authorization: Bearer $DEVELOPER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Dev Site","latitude":-1.28,"longitude":36.81,"address":"1 Dev Way"}'
```

Expected: `400 Bad Request`, message mentions "linked account".

```bash
# Developer WITH a linked-contractor personnel entry — expect 201, contractorId = the contractor's id
curl -s -X POST http://localhost:5000/sites -H "Authorization: Bearer $DEVELOPER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Dev Site\",\"latitude\":-1.28,\"longitude\":36.81,\"address\":\"1 Dev Way\",\"personnel\":[{\"role\":\"CONTRACTOR\",\"userId\":\"$CONTRACTOR_ID\"}]}"
```

Expected: `201`, response `contractorId` equals `$CONTRACTOR_ID`. Copy the site id into `$SITE_ID`. Confirm the developer is NOT auto-added as personnel (only the one `CONTRACTOR` entry exists) — this is expected since the developer didn't include themselves.

```bash
# Now register again, this time including the developer as DEVELOPER personnel, so edit access works
curl -s -X POST http://localhost:5000/sites -H "Authorization: Bearer $DEVELOPER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Dev Site 2\",\"latitude\":-1.28,\"longitude\":36.81,\"address\":\"2 Dev Way\",\"personnel\":[{\"role\":\"CONTRACTOR\",\"userId\":\"$CONTRACTOR_ID\"},{\"role\":\"DEVELOPER\",\"name\":\"placeholder\"}]}"
```

Wait — a `DEVELOPER` entry for the developer themselves needs their own `userId`, not a freeform name (freeform wouldn't grant edit rights, since `assertOwnerOrAdmin` checks `userId`). Re-run with the developer's own id (fetch it from a `GET /users/lookup?email=srm-developer@example.com` call, or capture it from the signup response the same way `$CONTRACTOR_ID` was captured above) instead of `"name":"placeholder"`, then:

```bash
curl -i -X PATCH http://localhost:5000/sites/$SITE_ID_2 -H "Authorization: Bearer $DEVELOPER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expectedEndDate":"2027-06-30"}'
```

Expected: `200 OK` — the developer, linked via `SitePersonnel(role: DEVELOPER)`, can now edit. Stop the dev server, clean up all test data.

- [ ] **Step 7: Commit**

```bash
git add src/sites/sites.controller.ts src/sites/sites.service.ts
git commit -m "feat: allow developer to register and edit sites via linked personnel"
```

---

### Task 3: Backend — `GET /users/lookup`

**Files:**
- Create: `src/users/dto/lookup-user.dto.ts`
- Modify: `src/users/users.controller.ts`
- Modify: `src/users/users.service.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /users/lookup?email=...` → `{id, name}` or `404`. Task 5's `usersApi.ts` calls this exact route/shape.

- [ ] **Step 1: Write `LookupUserDto`**

`src/users/dto/lookup-user.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class LookupUserDto {
  @ApiProperty()
  @IsEmail()
  email: string;
}
```

- [ ] **Step 2: Add `lookupByEmail` to `UsersService`**

Modify `src/users/users.service.ts` — add after `findSelf`:

```typescript
  async lookupByEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true },
    });
    if (!user) {
      throw new NotFoundException('No user found with that email');
    }
    return user;
  }
```

- [ ] **Step 3: Add the route to `UsersController`**

Modify `src/users/users.controller.ts` — add the `Query` import and the `LookupUserDto` import, and a new route after `updateSelf`:

```typescript
import { Body, Controller, Get, Ip, Param, Patch, Query } from '@nestjs/common';
```

```typescript
import { LookupUserDto } from './dto/lookup-user.dto';
```

```typescript
  @ApiOperation({ summary: 'Look up a user by email (any authenticated user) — for linking site personnel' })
  @Get('lookup')
  lookup(@Query() query: LookupUserDto) {
    return this.usersService.lookupByEmail(query.email);
  }
```

(Place this route before `findAll()`'s `@Get()` — order doesn't affect matching here since there's no `@Get(':id')` on this controller to conflict with, but keeping GETs grouped together is clearer.)

- [ ] **Step 4: Build and verify**

```bash
pnpm run build
pnpm run start:dev
```

```bash
TOKEN=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"lookup-test@example.com","password":"password123","name":"Lookup Test","roles":["contractor"]}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

curl -i http://localhost:5000/users/lookup?email=lookup-test@example.com -H "Authorization: Bearer $TOKEN"
curl -i http://localhost:5000/users/lookup?email=nobody@example.com -H "Authorization: Bearer $TOKEN"
```

Expected: first call → `200 {"id":"...","name":"Lookup Test"}`; second → `404`. Stop the dev server, clean up the test user.

- [ ] **Step 5: Commit**

```bash
git add src/users
git commit -m "feat: add GET /users/lookup for resolving an email to a linkable account"
```

---

### Task 4: sitesight-pro — `usePermissions.ts`

**Files:**
- Modify: `src/hooks/usePermissions.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `developer` now includes `'create_sites'`/`'edit_sites'` — Task 9's `Sites.tsx`/`SiteDetail.tsx` checks depend on this.

- [ ] **Step 1: Add the two permissions to `developer`**

Modify `src/hooks/usePermissions.ts`:

```typescript
  developer: [
    'view_sites',
    'create_sites',
    'edit_sites',
    'view_inspections',
    'create_inspection_requests',
    'view_reports',
  ],
```

(`delete_sites` deliberately **not** added — `DELETE /sites/:id` stays contractor/admin-only, per Global Constraints.)

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePermissions.ts
git commit -m "feat: grant developer create_sites/edit_sites permissions"
```

---

### Task 5: sitesight-pro — `kenyaCounties.ts`, `sitesApi.ts`, `usersApi.ts`

**Files:**
- Create: `src/lib/kenyaCounties.ts`
- Modify: `src/store/api/sitesApi.ts`
- Modify: `src/store/api/usersApi.ts`

**Interfaces:**
- Consumes: the backend shapes from Tasks 1–3.
- Produces: `KENYA_COUNTIES`, extended `Site`/`CreateSitePayload`/`UpdateSitePayload`/new `SiteApprovals`/`SitePersonnelEntry`/`SitePersonnelInput` types, `useLazyLookupUserByEmailQuery`. Tasks 6–9 all depend on these exact type/hook names.

- [ ] **Step 1: Write `kenyaCounties.ts`**

`src/lib/kenyaCounties.ts`:

```typescript
export const KENYA_COUNTIES = [
  "Mombasa", "Kwale", "Kilifi", "Tana River", "Lamu", "Taita-Taveta", "Garissa", "Wajir",
  "Mandera", "Marsabit", "Isiolo", "Meru", "Tharaka-Nithi", "Embu", "Kitui", "Machakos",
  "Makueni", "Nyandarua", "Nyeri", "Kirinyaga", "Murang'a", "Kiambu", "Turkana", "West Pokot",
  "Samburu", "Trans Nzoia", "Uasin Gishu", "Elgeyo-Marakwet", "Nandi", "Baringo", "Laikipia",
  "Nakuru", "Narok", "Kajiado", "Kericho", "Bomet", "Kakamega", "Vihiga", "Bungoma", "Busia",
  "Siaya", "Kisumu", "Homa Bay", "Migori", "Kisii", "Nyamira", "Nairobi",
] as const;
```

- [ ] **Step 2: Rewrite `sitesApi.ts`**

`src/store/api/sitesApi.ts`:

```typescript
import { baseApi } from './baseApi';

export type DevelopmentType = 'RESIDENTIAL' | 'COMMERCIAL' | 'INDUSTRIAL' | 'MIXED_USE' | 'INSTITUTIONAL';
export type SitePersonnelRole = 'DEVELOPER' | 'SITE_REPRESENTATIVE' | 'CONTRACTOR' | 'QUANTITY_SURVEYOR' | 'ENGINEER';
export type ApprovalStatus = 'VALID' | 'PENDING' | 'EXPIRED';

export interface ApprovalEntry {
  status: ApprovalStatus;
  reference?: string;
}

export interface SiteApprovals {
  county?: ApprovalEntry;
  nema?: ApprovalEntry;
  nca?: ApprovalEntry;
}

export interface SitePersonnelEntry {
  id?: string;
  role: SitePersonnelRole;
  userId?: string;
  userName?: string;
  name?: string;
  contact?: string;
}

export interface SitePersonnelInput {
  role: SitePersonnelRole;
  userId?: string;
  name?: string;
  contact?: string;
}

export interface Site {
  id: string;
  name: string;
  contractor_id: string;
  latitude: number;
  longitude: number;
  geofence_radius: number;
  address: string;
  construction_phase?: string;
  status: string;
  development_type?: DevelopmentType;
  country?: string;
  county?: string;
  constituency?: string;
  town?: string;
  plot_number?: string;
  expected_end_date?: string;
  landmarks: string[];
  approvals?: SiteApprovals;
  personnel: SitePersonnelEntry[];
  created_at: string;
  updated_at: string;
  contractor_name?: string;
  contractor_company?: string;
}

interface BackendSitePersonnel {
  id: string;
  role: SitePersonnelRole;
  userId: string | null;
  name: string | null;
  contact: string | null;
  user: { id: string; name: string; email: string } | null;
}

interface BackendSite {
  id: string;
  name: string;
  contractorId: string;
  latitude: string | number;
  longitude: string | number;
  geofenceRadius: number;
  address: string;
  constructionPhase: string | null;
  status: string;
  developmentType: DevelopmentType | null;
  country: string | null;
  county: string | null;
  constituency: string | null;
  town: string | null;
  plotNumber: string | null;
  expectedEndDate: string | null;
  landmarks: string[];
  approvals: SiteApprovals | null;
  personnel: BackendSitePersonnel[];
  createdAt: string;
  updatedAt: string;
  contractor: { id: string; name: string; company: string | null } | null;
}

function mapSite(site: BackendSite): Site {
  return {
    id: site.id,
    name: site.name,
    contractor_id: site.contractorId,
    latitude: Number(site.latitude),
    longitude: Number(site.longitude),
    geofence_radius: site.geofenceRadius,
    address: site.address,
    construction_phase: site.constructionPhase ?? undefined,
    status: site.status,
    development_type: site.developmentType ?? undefined,
    country: site.country ?? undefined,
    county: site.county ?? undefined,
    constituency: site.constituency ?? undefined,
    town: site.town ?? undefined,
    plot_number: site.plotNumber ?? undefined,
    expected_end_date: site.expectedEndDate ?? undefined,
    landmarks: site.landmarks ?? [],
    approvals: site.approvals ?? undefined,
    personnel: (site.personnel ?? []).map((p) => ({
      id: p.id,
      role: p.role,
      userId: p.userId ?? undefined,
      userName: p.user?.name,
      name: p.name ?? undefined,
      contact: p.contact ?? undefined,
    })),
    created_at: site.createdAt,
    updated_at: site.updatedAt,
    contractor_name: site.contractor?.name,
    contractor_company: site.contractor?.company ?? undefined,
  };
}

export interface CreateSitePayload {
  name: string;
  latitude: number;
  longitude: number;
  geofenceRadius?: number;
  address: string;
  constructionPhase?: string;
  developmentType?: DevelopmentType;
  country?: string;
  county?: string;
  constituency?: string;
  town?: string;
  plotNumber?: string;
  expectedEndDate?: string;
  landmarks?: string[];
  approvals?: SiteApprovals;
  personnel?: SitePersonnelInput[];
}

export interface UpdateSitePayload extends Partial<CreateSitePayload> {
  id: string;
  status?: string;
}

export const sitesApi = baseApi.injectEndpoints({
  endpoints: (builder) => ({
    getSites: builder.query<Site[], void>({
      query: () => '/sites',
      transformResponse: (sites: BackendSite[]) => sites.map(mapSite),
      providesTags: (result) => [
        ...(result ?? []).map((s) => ({ type: 'Site' as const, id: s.id })),
        { type: 'Site' as const, id: 'LIST' },
      ],
    }),
    getSite: builder.query<Site, string>({
      query: (id) => `/sites/${id}`,
      transformResponse: mapSite,
      providesTags: (_result, _error, id) => [{ type: 'Site' as const, id }],
    }),
    createSite: builder.mutation<Site, CreateSitePayload>({
      query: (body) => ({ url: '/sites', method: 'POST', body }),
      transformResponse: mapSite,
      invalidatesTags: [{ type: 'Site' as const, id: 'LIST' }],
    }),
    updateSite: builder.mutation<Site, UpdateSitePayload>({
      query: ({ id, ...body }) => ({ url: `/sites/${id}`, method: 'PATCH', body }),
      transformResponse: mapSite,
      invalidatesTags: (_result, _error, { id }) => [
        { type: 'Site' as const, id },
        { type: 'Site' as const, id: 'LIST' },
      ],
    }),
    deleteSite: builder.mutation<void, string>({
      query: (id) => ({ url: `/sites/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'Site' as const, id: 'LIST' }],
    }),
  }),
});

export const {
  useGetSitesQuery,
  useGetSiteQuery,
  useCreateSiteMutation,
  useUpdateSiteMutation,
  useDeleteSiteMutation,
} = sitesApi;
```

- [ ] **Step 3: Add the lookup query to `usersApi.ts`**

Modify `src/store/api/usersApi.ts` — add the interface and endpoint:

```typescript
export interface UserLookupResult {
  id: string;
  name: string;
}
```

Inside `injectEndpoints`'s `endpoints:` object, after `updateProfile`:

```typescript
    lookupUserByEmail: builder.query<UserLookupResult, string>({
      query: (email) => `/users/lookup?email=${encodeURIComponent(email)}`,
    }),
```

Add to the export block:

```typescript
export const {
  useUpdateProfileMutation,
  useGetUsersQuery,
  useUpdateUserStatusMutation,
  useUpdateUserRolesMutation,
  useLazyLookupUserByEmailQuery,
} = usersApi;
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

Expected: errors in `SiteCreate.tsx` (still using the old flat `CreateSitePayload` shape correctly — it should actually still compile fine since it only uses a subset of now-optional fields; if it does error, note the exact error for Step 5 investigation, since Task 9 deletes this file anyway).

- [ ] **Step 5: Commit**

```bash
git add src/lib/kenyaCounties.ts src/store/api/sitesApi.ts src/store/api/usersApi.ts
git commit -m "feat: extend Site types with full registration field set, add user email lookup"
```

---

### Task 6: sitesight-pro — `SiteLandmarksField.tsx` and `SiteApprovalsField.tsx`

**Files:**
- Create: `src/components/sites/SiteLandmarksField.tsx`
- Create: `src/components/sites/SiteApprovalsField.tsx`

**Interfaces:**
- Consumes: `SiteFormValues` type — **not yet defined** (Task 8 defines and exports it from `SiteRegistrationDialog.tsx`). This creates a temporary circular-looking reference: these two files import a type from a file that doesn't exist until Task 8. To avoid that, both files define their own minimal local type expectations via `useFormContext<{ landmarks: string[] }>()` / `useFormContext<{ approvals: SiteApprovals }>()` (structurally compatible with whatever the full `SiteFormValues` turns out to be — TypeScript structural typing accepts this) rather than importing a type that doesn't exist yet. Task 8 does not need to change these files.
- Produces: `SiteLandmarksField`, `SiteApprovalsField` components — Task 8 renders both inside the main form.

- [ ] **Step 1: Write `SiteLandmarksField.tsx`**

`src/components/sites/SiteLandmarksField.tsx`:

```tsx
import { useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { X, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

interface LandmarksFormShape {
  landmarks: string[];
}

export function SiteLandmarksField() {
  const { watch, setValue } = useFormContext<LandmarksFormShape>();
  const landmarks = watch('landmarks') ?? [];
  const [draft, setDraft] = useState('');

  const addLandmark = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setValue('landmarks', [...landmarks, trimmed]);
    setDraft('');
  };

  const removeLandmark = (index: number) => {
    setValue(
      'landmarks',
      landmarks.filter((_, i) => i !== index),
    );
  };

  return (
    <div className="space-y-2">
      <Label>Nearby Landmarks</Label>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addLandmark();
            }
          }}
          placeholder="e.g. Near Sarit Centre"
        />
        <Button type="button" variant="outline" onClick={addLandmark}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {landmarks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {landmarks.map((landmark, index) => (
            <Badge key={`${landmark}-${index}`} variant="secondary" className="gap-1">
              {landmark}
              <button type="button" onClick={() => removeLandmark(index)}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `SiteApprovalsField.tsx`**

`src/components/sites/SiteApprovalsField.tsx`:

```tsx
import { useFormContext } from 'react-hook-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SiteApprovals } from '@/store/api/sitesApi';

interface ApprovalsFormShape {
  approvals: SiteApprovals;
}

const AUTHORITIES = [
  { key: 'county', label: 'County Approval' },
  { key: 'nema', label: 'NEMA Approval' },
  { key: 'nca', label: 'NCA Approval' },
] as const;

export function SiteApprovalsField() {
  const { watch, setValue } = useFormContext<ApprovalsFormShape>();
  const approvals = watch('approvals') ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Approvals</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {AUTHORITIES.map(({ key, label }) => {
          const entry = approvals[key];
          return (
            <div key={key} className="grid grid-cols-2 gap-3 pb-3 border-b last:border-0">
              <div className="space-y-2">
                <Label>{label}</Label>
                <Select
                  value={entry?.status ?? 'unset'}
                  onValueChange={(value) => {
                    if (value === 'unset') {
                      const rest = { ...approvals };
                      delete rest[key];
                      setValue('approvals', rest);
                      return;
                    }
                    setValue('approvals', {
                      ...approvals,
                      [key]: { ...entry, status: value as 'VALID' | 'PENDING' | 'EXPIRED' },
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Not set" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unset">Not set</SelectItem>
                    <SelectItem value="VALID">Valid</SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="EXPIRED">Expired</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Reference</Label>
                <Input
                  value={entry?.reference ?? ''}
                  disabled={!entry}
                  onChange={(e) =>
                    setValue('approvals', { ...approvals, [key]: { ...entry, reference: e.target.value } })
                  }
                  placeholder="Reference number"
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

Expected: no new errors from these two files (they're not imported/used anywhere yet, so even if something were wrong internally, TS would only flag it via direct analysis, not usage — this step still catches real syntax/type errors within the files themselves).

- [ ] **Step 4: Commit**

```bash
git add src/components/sites/SiteLandmarksField.tsx src/components/sites/SiteApprovalsField.tsx
git commit -m "feat: add site landmarks and approvals form field components"
```

---

### Task 7: sitesight-pro — `SitePersonnelField.tsx`

**Files:**
- Create: `src/components/sites/SitePersonnelField.tsx`

**Interfaces:**
- Consumes: `useLazyLookupUserByEmailQuery` (Task 5), `SitePersonnelRole` (Task 5).
- Produces: `SitePersonnelField` component — Task 8 renders it inside the main form.

- [ ] **Step 1: Write `SitePersonnelField.tsx`**

`src/components/sites/SitePersonnelField.tsx`:

```tsx
import { useState } from 'react';
import { useFieldArray, useFormContext } from 'react-hook-form';
import { Plus, Trash2, Search, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLazyLookupUserByEmailQuery } from '@/store/api/usersApi';
import type { SitePersonnelRole } from '@/store/api/sitesApi';

export interface PersonnelFormEntry {
  role: SitePersonnelRole;
  userId?: string;
  userName?: string;
  name?: string;
  contact?: string;
}

interface PersonnelFormShape {
  personnel: PersonnelFormEntry[];
}

const ROLE_OPTIONS: { value: SitePersonnelRole; label: string }[] = [
  { value: 'DEVELOPER', label: 'Developer' },
  { value: 'SITE_REPRESENTATIVE', label: 'Site Representative' },
  { value: 'CONTRACTOR', label: 'Contractor' },
  { value: 'QUANTITY_SURVEYOR', label: 'Quantity Surveyor' },
  { value: 'ENGINEER', label: 'Engineer' },
];

function PersonnelRow({ index, onRemove }: { index: number; onRemove: () => void }) {
  const { watch, setValue } = useFormContext<PersonnelFormShape>();
  const entry = watch(`personnel.${index}`);
  const [mode, setMode] = useState<'link' | 'freeform'>(entry.userId ? 'link' : 'freeform');
  const [email, setEmail] = useState('');
  const [lookup, { isFetching }] = useLazyLookupUserByEmailQuery();
  const [lookupError, setLookupError] = useState<string | null>(null);

  const clearIdentity = () => {
    setValue(`personnel.${index}.userId`, undefined);
    setValue(`personnel.${index}.userName`, undefined);
    setValue(`personnel.${index}.name`, undefined);
    setValue(`personnel.${index}.contact`, undefined);
  };

  const handleLookup = async () => {
    setLookupError(null);
    try {
      const result = await lookup(email).unwrap();
      setValue(`personnel.${index}.userId`, result.id);
      setValue(`personnel.${index}.userName`, result.name);
      setValue(`personnel.${index}.name`, undefined);
      setValue(`personnel.${index}.contact`, undefined);
    } catch {
      setLookupError('No user found with that email');
    }
  };

  return (
    <div className="space-y-3 p-3 border rounded-lg">
      <div className="flex items-center justify-between">
        <Select
          value={entry.role}
          onValueChange={(value) => setValue(`personnel.${index}.role`, value as SitePersonnelRole)}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <Tabs
        value={mode}
        onValueChange={(value) => {
          setMode(value as 'link' | 'freeform');
          clearIdentity();
          setLookupError(null);
        }}
      >
        <TabsList>
          <TabsTrigger value="link">Link account</TabsTrigger>
          <TabsTrigger value="freeform">Freeform contact</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === 'link' ? (
        entry.userId ? (
          <div className="flex items-center gap-2 text-sm text-success">
            <Check className="h-4 w-4" />
            Linked: {entry.userName}
            <Button type="button" variant="ghost" size="sm" onClick={clearIdentity}>
              Change
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder="person@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="button" variant="outline" onClick={handleLookup} disabled={isFetching || !email}>
              <Search className="h-4 w-4" />
            </Button>
          </div>
        )
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="Full name"
            value={entry.name ?? ''}
            onChange={(e) => setValue(`personnel.${index}.name`, e.target.value)}
          />
          <Input
            placeholder="Phone or email"
            value={entry.contact ?? ''}
            onChange={(e) => setValue(`personnel.${index}.contact`, e.target.value)}
          />
        </div>
      )}
      {lookupError && <p className="text-xs text-destructive">{lookupError}</p>}
    </div>
  );
}

export function SitePersonnelField() {
  const { control } = useFormContext<PersonnelFormShape>();
  const { fields, append, remove } = useFieldArray({ control, name: 'personnel' });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Personnel</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {fields.map((field, index) => (
          <PersonnelRow key={field.id} index={index} onRemove={() => remove(index)} />
        ))}
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => append({ role: 'CONTRACTOR' })}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Personnel
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 3: Commit**

```bash
git add src/components/sites/SitePersonnelField.tsx
git commit -m "feat: add site personnel form field component with account-linking lookup"
```

---

### Task 8: sitesight-pro — `SiteRegistrationDialog.tsx`

**Files:**
- Create: `src/components/sites/SiteRegistrationDialog.tsx`

**Interfaces:**
- Consumes: `SiteLandmarksField`/`SiteApprovalsField` (Task 6), `SitePersonnelField` (Task 7), `Site`/`CreateSitePayload`/`UpdateSitePayload`/`KENYA_COUNTIES` (Task 5), `useGeolocation` (existing).
- Produces: `SiteRegistrationDialog` component with props `{ open: boolean; onOpenChange: (open: boolean) => void; site?: Site }` — Task 9 renders it from both `Sites.tsx` and `SiteDetail.tsx`.

- [ ] **Step 1: Write `SiteRegistrationDialog.tsx`**

`src/components/sites/SiteRegistrationDialog.tsx`:

```tsx
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigation } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { useGeolocation } from '@/hooks/useGeolocation';
import { useCreateSiteMutation, useUpdateSiteMutation, type Site } from '@/store/api/sitesApi';
import { KENYA_COUNTIES } from '@/lib/kenyaCounties';
import { SiteLandmarksField } from './SiteLandmarksField';
import { SiteApprovalsField } from './SiteApprovalsField';
import { SitePersonnelField } from './SitePersonnelField';

const approvalEntrySchema = z.object({
  status: z.enum(['VALID', 'PENDING', 'EXPIRED']),
  reference: z.string().optional(),
});

const personnelEntrySchema = z
  .object({
    role: z.enum(['DEVELOPER', 'SITE_REPRESENTATIVE', 'CONTRACTOR', 'QUANTITY_SURVEYOR', 'ENGINEER']),
    userId: z.string().optional(),
    userName: z.string().optional(),
    name: z.string().optional(),
    contact: z.string().optional(),
  })
  .refine((entry) => Boolean(entry.userId) !== Boolean(entry.name), {
    message: 'Provide exactly one of a linked account or a freeform name',
    path: ['name'],
  });

const siteFormSchema = z.object({
  name: z.string().min(1, 'Site name is required'),
  address: z.string().min(1, 'Address is required'),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  geofenceRadius: z.coerce.number().min(50).max(2000),
  constructionPhase: z.string().optional(),
  developmentType: z
    .enum(['RESIDENTIAL', 'COMMERCIAL', 'INDUSTRIAL', 'MIXED_USE', 'INSTITUTIONAL'])
    .optional(),
  country: z.string().optional(),
  county: z.string().optional(),
  constituency: z.string().optional(),
  town: z.string().optional(),
  plotNumber: z.string().optional(),
  expectedEndDate: z.string().optional(),
  landmarks: z.array(z.string()).default([]),
  approvals: z
    .object({
      county: approvalEntrySchema.optional(),
      nema: approvalEntrySchema.optional(),
      nca: approvalEntrySchema.optional(),
    })
    .default({}),
  personnel: z.array(personnelEntrySchema).default([]),
});

type SiteFormValues = z.infer<typeof siteFormSchema>;

const EMPTY_VALUES: SiteFormValues = {
  name: '',
  address: '',
  latitude: 0,
  longitude: 0,
  geofenceRadius: 500,
  landmarks: [],
  approvals: {},
  personnel: [],
};

interface SiteRegistrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site?: Site;
}

export function SiteRegistrationDialog({ open, onOpenChange, site }: SiteRegistrationDialogProps) {
  const { toast } = useToast();
  const { latitude: gpsLat, longitude: gpsLon, getCurrentPosition, loading: geoLoading } = useGeolocation();
  const [createSite, { isLoading: creating }] = useCreateSiteMutation();
  const [updateSite, { isLoading: updating }] = useUpdateSiteMutation();
  const loading = creating || updating;

  const form = useForm<SiteFormValues>({
    resolver: zodResolver(siteFormSchema),
    defaultValues: EMPTY_VALUES,
  });

  useEffect(() => {
    if (!open) return;
    if (site) {
      form.reset({
        name: site.name,
        address: site.address,
        latitude: site.latitude,
        longitude: site.longitude,
        geofenceRadius: site.geofence_radius,
        constructionPhase: site.construction_phase,
        developmentType: site.development_type,
        country: site.country,
        county: site.county,
        constituency: site.constituency,
        town: site.town,
        plotNumber: site.plot_number,
        expectedEndDate: site.expected_end_date,
        landmarks: site.landmarks,
        approvals: site.approvals ?? {},
        personnel: site.personnel,
      });
    } else {
      form.reset(EMPTY_VALUES);
    }
  }, [open, site, form]);

  useEffect(() => {
    if (gpsLat != null && gpsLon != null) {
      form.setValue('latitude', gpsLat);
      form.setValue('longitude', gpsLon);
    }
  }, [gpsLat, gpsLon, form]);

  const onSubmit = async (values: SiteFormValues) => {
    const payload = {
      name: values.name,
      address: values.address,
      latitude: values.latitude,
      longitude: values.longitude,
      geofenceRadius: values.geofenceRadius,
      constructionPhase: values.constructionPhase || undefined,
      developmentType: values.developmentType,
      country: values.country || undefined,
      county: values.county || undefined,
      constituency: values.constituency || undefined,
      town: values.town || undefined,
      plotNumber: values.plotNumber || undefined,
      expectedEndDate: values.expectedEndDate || undefined,
      landmarks: values.landmarks,
      approvals: values.approvals,
      personnel: values.personnel.map((p) => ({
        role: p.role,
        userId: p.userId,
        name: p.name,
        contact: p.contact,
      })),
    };

    try {
      if (site) {
        await updateSite({ id: site.id, ...payload }).unwrap();
        toast({ title: 'Site updated', description: 'Changes have been saved.' });
      } else {
        await createSite(payload).unwrap();
        toast({ title: 'Site registered', description: 'The new site has been created.' });
      }
      onOpenChange(false);
    } catch (error) {
      toast({
        title: 'Error',
        description: site ? 'Failed to update site.' : 'Failed to register site.',
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{site ? 'Edit Site' : 'Register Site'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Site Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g., Downtown Plaza Tower" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Full site address" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="developmentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Development Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="RESIDENTIAL">Residential</SelectItem>
                        <SelectItem value="COMMERCIAL">Commercial</SelectItem>
                        <SelectItem value="INDUSTRIAL">Industrial</SelectItem>
                        <SelectItem value="MIXED_USE">Mixed Use</SelectItem>
                        <SelectItem value="INSTITUTIONAL">Institutional</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expectedEndDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected End Date</FormLabel>
                    <FormControl>
                      <Input {...field} type="date" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="country"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Country</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Kenya" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="county"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>County</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select county" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {KENYA_COUNTIES.map((county) => (
                          <SelectItem key={county} value={county}>
                            {county}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="constituency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Constituency</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="town"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Town</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="plotNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Plot Number</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="LR 209/1234" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>GPS Location</Label>
                <Button type="button" variant="outline" size="sm" onClick={getCurrentPosition} disabled={geoLoading}>
                  <Navigation className="h-4 w-4 mr-2" />
                  Use Current Location
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="latitude"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Latitude</FormLabel>
                      <FormControl>
                        <Input {...field} type="number" step="any" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="longitude"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Longitude</FormLabel>
                      <FormControl>
                        <Input {...field} type="number" step="any" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <FormField
              control={form.control}
              name="geofenceRadius"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Geofence Radius (meters)</FormLabel>
                  <FormControl>
                    <Input {...field} type="number" min="50" max="2000" />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    Engineers must be within this radius to perform inspections
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="constructionPhase"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Construction Phase</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g., Foundation" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <SiteLandmarksField />
            <SiteApprovalsField />
            <SitePersonnelField />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {site ? 'Save Changes' : 'Register Site'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

Expected: clean (this component isn't rendered anywhere yet, but its own internals should type-check).

- [ ] **Step 3: Commit**

```bash
git add src/components/sites/SiteRegistrationDialog.tsx
git commit -m "feat: add SiteRegistrationDialog combining all site form fields"
```

---

### Task 9: sitesight-pro — wire it up, remove the old page

**Files:**
- Modify: `src/pages/Sites.tsx`
- Modify: `src/pages/SiteDetail.tsx`
- Delete: `src/pages/SiteCreate.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `SiteRegistrationDialog` (Task 8).
- Produces: nothing consumed elsewhere — last task.

- [ ] **Step 1: Modify `Sites.tsx`**

Add imports and state; replace both `<Link to="/sites/new">` occurrences with dialog triggers:

```typescript
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Filter, MapPin, Building2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAppSelector } from '@/store/hooks';
import { useGetSitesQuery } from '@/store/api/sitesApi';
import { hasPermission } from '@/hooks/usePermissions';
import { SiteRegistrationDialog } from '@/components/sites/SiteRegistrationDialog';

export default function Sites() {
  const { data: sites = [], isLoading: loading } = useGetSitesQuery();
  const { roles } = useAppSelector((state) => state.auth);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [isAddOpen, setIsAddOpen] = useState(false);

  const filteredSites = sites.filter((site) => {
    const matchesSearch =
      site.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      site.address.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (site.contractor_name?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false);
    const matchesStatus = statusFilter === 'all' || site.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const canCreateSite = hasPermission(roles, 'create_sites');

  return (
    <AppLayout>
      <PageHeader
        title="Sites"
        subtitle={`${filteredSites.length} construction sites`}
        actions={
          canCreateSite && (
            <Button variant="default" size="sm" onClick={() => setIsAddOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Add Site</span>
            </Button>
          )
        }
      />

      <div className="p-4 space-y-4 animate-fade-in">
        {/* Search and Filter */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search sites..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button variant="outline" size="icon">
            <Filter className="h-4 w-4" />
          </Button>
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-2">
          {(['all', 'active', 'inactive'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                statusFilter === status
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>

        {/* Sites List */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-4">
                  <div className="h-20 bg-muted rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSites.map((site) => (
              <Link key={site.id} to={`/sites/${site.id}`} className='mb-3'>
                <Card className="card-elevated hover:shadow-lg transition-shadow mb-3">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="p-2.5 rounded-lg bg-primary/10 text-primary">
                          <MapPin className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-foreground">{site.name}</h3>
                          <p className="text-sm text-muted-foreground line-clamp-1">
                            {site.address}
                          </p>
                        </div>
                      </div>
                      <Badge variant={site.status === 'active' ? 'default' : 'secondary'}>
                        {site.status}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Building2 className="h-4 w-4" />
                        {site.contractor_name || 'Unknown'}
                      </span>
                      {site.construction_phase && (
                        <span className="px-2 py-0.5 bg-muted rounded text-xs">
                          {site.construction_phase}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}

            {filteredSites.length === 0 && (
              <div className="text-center py-12">
                <MapPin className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
                <p className="text-muted-foreground">No sites found</p>
                {canCreateSite && (
                  <Button className="mt-4" onClick={() => setIsAddOpen(true)}>
                    Add Your First Site
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <SiteRegistrationDialog open={isAddOpen} onOpenChange={setIsAddOpen} />
    </AppLayout>
  );
}
```

- [ ] **Step 2: Modify `SiteDetail.tsx`**

Add the dialog import/state, wire the "Edit Site" button, and fix `canEdit` to account for a linked `DEVELOPER` personnel entry:

```typescript
import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, MapPin, Building2, Calendar, Navigation, Edit, Trash2 } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAppSelector } from '@/store/hooks';
import { useGetSiteQuery, useDeleteSiteMutation } from '@/store/api/sitesApi';
import { hasPermission } from '@/hooks/usePermissions';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { SiteRegistrationDialog } from '@/components/sites/SiteRegistrationDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

export default function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: currentSite, isLoading: loading } = useGetSiteQuery(id ?? '', { skip: !id });
  const [deleteSite] = useDeleteSiteMutation();
  const { roles, user } = useAppSelector((state) => state.auth);
  const [isEditOpen, setIsEditOpen] = useState(false);

  const isLinkedDeveloper = currentSite?.personnel.some(
    (p) => p.role === 'DEVELOPER' && p.userId === user?.id,
  );

  const canEdit =
    hasPermission(roles, 'edit_sites') &&
    (currentSite?.contractor_id === user?.id || isLinkedDeveloper || hasPermission(roles, 'manage_users'));

  const canDelete =
    hasPermission(roles, 'delete_sites') &&
    (currentSite?.contractor_id === user?.id || hasPermission(roles, 'manage_users'));
```

(Everything from `handleDelete` through the "GPS & Geofence" `Card` is unchanged — only the "Actions" section's Edit button and the very end of the component change:)

```tsx
        {(canEdit || canDelete) && (
          <div className="flex gap-2 pt-4 border-t">
            {canEdit && (
              <Button variant="outline" className="flex-1" onClick={() => setIsEditOpen(true)}>
                <Edit className="h-4 w-4 mr-2" />
                Edit Site
              </Button>
            )}
            {canDelete && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="icon">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Site?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. All inspection requests and reports
                      associated with this site will also be deleted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}
      </div>

      {currentSite && (
        <SiteRegistrationDialog open={isEditOpen} onOpenChange={setIsEditOpen} site={currentSite} />
      )}
    </AppLayout>
  );
}
```

- [ ] **Step 3: Delete `SiteCreate.tsx` and remove its route**

```bash
rm src/pages/SiteCreate.tsx
```

Modify `src/App.tsx` — remove the `SiteCreate` import and the `/sites/new` route:

```typescript
import Sites from "./pages/Sites";
import SiteDetail from "./pages/SiteDetail";
```

(delete the `import SiteCreate from "./pages/SiteCreate";` line)

```typescript
        <Route
          path="/sites"
          element={
            <ProtectedRoute>
              <Sites />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sites/:id"
          element={
            <ProtectedRoute>
              <SiteDetail />
            </ProtectedRoute>
          }
        />
```

(delete the entire `/sites/new` `<Route>` block between them)

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 5: Manually verify in the browser**

Start both dev servers. Log in as a contractor: open Sites, click "Add Site", fill in the full form (name, address, GPS via "Use Current Location", county dropdown, an approval, a landmark, a personnel entry via both "Link account" — using a real test user's email — and "Freeform contact"), submit, confirm the new site appears and its detail page shows the data. Click "Edit Site" on it, change a field, save, confirm it persists. Log in as a developer with no sites: attempt to add a site with only a freeform-contact `CONTRACTOR` personnel entry — confirm the submission fails with a clear error (matching the backend's `400`); retry with a linked-account `CONTRACTOR` entry — confirm it succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Sites.tsx src/pages/SiteDetail.tsx src/App.tsx
git add -u src/pages/SiteCreate.tsx
git commit -m "feat: wire up SiteRegistrationDialog for create and edit, remove SiteCreate page"
```

---

## Self-Review Notes

- **Spec coverage:** `expectedEndDate` (design §1) — Task 1. Developer registration/edit + `contractorId` derivation (design §2) — Task 2. `GET /users/lookup` (design §3) — Task 3. Component structure (design §4) — Tasks 6–8. Wiring and removed page (design §5) — Task 9 (plus Task 4 for the permission prerequisite). Testing approach (design §6) — every task's manual verification step.
- **Placeholder scan:** No "TBD"/"add validation" phrasing. Every code step has literal file contents. Task 2 Step 6's verification flow includes an explicit aside about needing the developer's own id for the second registration call rather than glossing over it — that's a real verification-sequencing note, not a placeholder.
- **Type consistency check:** `SiteFormValues` (Task 8) matches `Site`/`CreateSitePayload` field names (Task 5) exactly on every field the form reads/writes. `SitePersonnelEntry`/`SitePersonnelInput` (Task 5) both use `userId`/`name`/`contact`/`role` — the same shape `SitePersonnelField.tsx` (Task 7) and `SiteRegistrationDialog.tsx` (Task 8) both read/write, and the same shape the backend's `SitePersonnelInputDto` (existing, from Spec 1) expects on submit. `useLazyLookupUserByEmailQuery` (Task 5's export) is the exact hook name Task 7 imports. Tasks 6's two field components deliberately use locally-scoped `useFormContext` shape types instead of importing `SiteFormValues` from Task 8, to avoid an implementation-order dependency — confirmed this works via TypeScript structural typing (the local shapes are subsets of the real form values).
