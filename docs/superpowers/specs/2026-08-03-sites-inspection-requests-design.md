# Sites + InspectionRequests design

Date: 2026-08-03

## Purpose

Second vertical slice of `ujenzi-digital-be`, following the foundation/auth/users
slice (`docs/superpowers/plans/2026-08-02-foundation-auth-users.md`, fully
implemented). Implements the `Sites` and `InspectionRequests` modules from the
overall design (`2026-08-02-ujenzi-digital-be-design.md`, §3-4), plus adds
Swagger/OpenAPI documentation for the whole API. Inspections, Media, Reports,
and InspectionTemplates remain out of scope — separate future slices.

Frontend reference: `sitesight-pro` currently runs on mock data with its
Supabase queries for `sites`/`inspection_requests` commented out but left in
place as the intended query shape (no server-side pagination or filtering —
it always fetches the full list and filters client-side; denormalizes
contractor/engineer/site names into the list response). This design follows
that shape where it doesn't conflict with the already-established backend
conventions (camelCase, nested relations via Prisma `include` rather than
flattened denormalized fields).

## 1. Data model changes

`Site.status` widens from the currently-committed `active | inactive` to
`active | inactive | paused | completed`, matching values observed in the
frontend's mock data. Stays a Prisma `String` (not a Prisma `enum`) — validated
by a `class-validator` `@IsIn([...])` at the DTO layer, same pattern as
`UpdateStatusDto` for `User.status`. This needs a Prisma migration to update
column comments/DTOs only; no schema migration is required since it was
already a plain `String` column.

No other schema changes. `Site` and `InspectionRequest` already have every
field needed (`geofenceRadius`, `engineerId` nullable, etc.) from the Task 1
migration.

## 2. Sites module

| Route | Access | Notes |
|---|---|---|
| `GET /sites` | any authenticated user | All sites, no pagination (matches frontend). Each result includes nested `contractor: { id, name, company }`. |
| `GET /sites/:id` | any authenticated user | Same shape, single record. 404 if missing. |
| `POST /sites` | contractor (self) or administrator (any `contractorId`) | Per the original design's deliberate deviation from Supabase RLS — admins may create on behalf of any contractor. `status` defaults to `active`. |
| `PATCH /sites/:id` | owning contractor or administrator | Partial update. |
| `DELETE /sites/:id` | owning contractor or administrator | Hard delete (cascades to `InspectionRequest`/`Inspection` via existing `onDelete: Cascade`). |

`SitesService.isWithinGeofence(lat: number, lon: number, site: Site): boolean`
— pure Haversine-distance helper, 100m default when `geofenceRadius` is unset.
Exported from `SitesModule` but not called anywhere in this slice; the
Inspections module (future slice) will call it when an engineer starts/submits
an inspection, mirroring the frontend's (currently disabled) intent in
`InspectionForm.tsx`.

DTOs: `CreateSiteDto` (`name`, `contractorId?` — admin only, validated in the
service not the DTO, `latitude`, `longitude`, `geofenceRadius?`, `address`,
`constructionPhase?`), `UpdateSiteDto` (all fields optional, same shape minus
`contractorId`), `UpdateSiteStatusDto` is not separate — status is just one of
the optional fields on `UpdateSiteDto`, validated against the 4-value list.

## 3. InspectionRequests module

Read access is role-scoped, unlike Sites: a contractor only sees their own
requests; an engineer or administrator sees all requests (any engineer needs
visibility into unclaimed `pending` requests to be able to accept one).

| Route | Access | Notes |
|---|---|---|
| `GET /inspection-requests` | contractor → own only; engineer/admin → all | No pagination. Nested `site: { id, name, address, latitude, longitude, geofenceRadius }`, `contractor: { id, name, company }`, `engineer: { id, name } \| null`. |
| `GET /inspection-requests/:id` | same scoping rule | 403 if a contractor requests one that isn't theirs; 404 if missing. |
| `POST /inspection-requests` | contractor (self) or administrator (any `contractorId`) | Body: `siteId`, `requestedDate`, `notes?`. Always created `status: pending`, `engineerId: null`. |
| `PATCH /inspection-requests/:id` | owning contractor (only while `status === pending`) or administrator (anytime) | Editable fields: `notes`, `requestedDate`, `siteId`. |
| `POST /inspection-requests/:id/accept` | engineer or administrator | Legal only from `pending`. Sets `status: accepted`. Engineer: `engineerId = caller.userId`. Administrator: must supply `engineerId` in the body (an admin isn't an engineer). |
| `POST /inspection-requests/:id/reject` | engineer or administrator | Legal only from `pending`. Sets `status: rejected`. |

`accepted → in_progress → completed` transitions are **not** implemented in
this slice — those are driven by the Inspections module (start/submit an
inspection), a later slice per the incremental plan.

Every mutation (create, update, accept, reject) calls
`AuditLogService.log(...)`, matching the pattern from Tasks 8/10/11 of the
foundation plan.

DTOs: `CreateInspectionRequestDto`, `UpdateInspectionRequestDto`,
`AcceptInspectionRequestDto` (`engineerId?` — required for admin callers,
ignored/forbidden for engineer callers who must accept as themselves).

## 4. Authorization notes

Both modules follow the existing `RolesGuard`/`@CurrentUser()` pattern.
Ownership checks (owning contractor, assigned engineer) happen in the service
layer, not via `@Roles()` — `@Roles()` only gates by role, so an
"owning contractor or administrator" check needs an explicit
`if (site.contractorId !== user.userId && !user.roles.includes('administrator')) throw new ForbiddenException()`
in the service method, same shape for the InspectionRequests ownership/scoping
checks.

## 5. API documentation (Swagger/OpenAPI)

Add `@nestjs/swagger`, configured globally in `main.ts`:

```typescript
const config = new DocumentBuilder()
  .setTitle('Ujenzi Digital API')
  .setVersion('1.0')
  .addBearerAuth()
  .build();
const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('docs', app, document);
```

Served at `GET /docs`, marked `@Public()` at the route level Nest sets up
internally (no guard changes needed — `SwaggerModule.setup` mounts its own
static routes outside the Nest routing/guard pipeline).

Scope: retroactively decorate every existing controller in addition to the two
new ones, so `/docs` is a complete, accurate reference from day one:

- `@ApiTags(...)` on every controller (`Auth`, `Users`, `AuditLog`, `Sites`,
  `InspectionRequests`).
- `@ApiBearerAuth()` on every controller except the `@Public()` routes in
  `AuthController` (signup/login/refresh/logout/csrf-token/google/google
  callback).
- `@ApiOperation({ summary: ... })` per route.
- `@ApiProperty()` (with `required`/`enum`/`example` where useful) on every
  existing DTO (`SignupDto`, `CompleteProfileDto`, `UpdateProfileDto`,
  `UpdateStatusDto`, `UpdateRolesDto`, `QueryAuditLogDto`) and every new DTO
  from this slice.
- `@ApiResponse()` for the standard success/error shapes isn't added per-route
  in this pass — the global `HttpExceptionFilter`'s `{ statusCode, message,
  error }` shape is documented once in the Swagger description text instead
  of repeated on every operation, to avoid annotation churn on every future
  route.

## 6. Testing

None in this pass, consistent with the rest of the project (design spec §9)
— manual `curl` verification per task, same as the foundation-auth-users plan.
