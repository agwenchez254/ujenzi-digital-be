# Inspection Redesign design

Date: 2026-08-13

## Purpose

Spec 3 of the 6-spec sequence. Replaces the fixed 10-item checklist with a
rich-text notes flow, and closes authorization gaps discovered while
investigating the current code: `GET /inspections`, `GET /inspections/:id`,
`GET /inspections/:id/media`, and `GET /media/:id/file` currently have **no
site-tie check at all** — any authenticated user can read any site's
inspection notes and photos. `POST /inspection-requests` lets a contractor
create a request for a site they don't own (only existence is checked, not
ownership). Both are fixed here alongside the new feature, since they're the
same underlying gap the "photos should be seen by the site engineer,
contractor, and developer tagged to that site" requirement is asking to close
correctly rather than just add a UI for.

Explicitly out of scope: `InspectionTemplate` (unused, unrelated to this
change), the `Report` model, and any new realtime events beyond the two
Spec 2 already wired (`inspection.started`/`inspection.submitted`) — a
single engineer's own in-progress work doesn't need per-photo-upload live
events. Also out of scope: the parallel `RolePermission`/JWT-`permissions`
system — it's currently decorative (computed into the JWT, never read by any
guard), so neither the backend authorization changes nor the frontend
`usePermissions.ts` fix in this spec integrate with it.

## 1. Data model

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
  notes      Json?                              // Tiptap/ProseMirror document, replaces
                                                  // checklistResponses + old notes/observations/recommendations
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

`checklistResponses`, the old `notes`/`observations`/`recommendations`
(`String?`) columns, and `ChecklistResponseItemDto` are all removed — no
backfill, this is pre-production test data only. `notes` is validated
loosely (`@IsOptional() @IsObject()`) rather than against ProseMirror's full
recursive node schema — the same pragmatic choice made for `Site.approvals`
in Spec 1's design: the frontend is trusted to send a well-formed Tiptap
document, and deep-validating an editor-internal tree isn't worth the DTO
complexity. `riskLevel` is unchanged.

Migration: since this is a plain column drop/add (no PostGIS-style raw SQL
needed), a normal `prisma migrate dev` generates the whole thing —
`ALTER TABLE "Inspection" DROP COLUMN "checklistResponses"`, drop the three
old string columns, `ADD COLUMN "notes" JSONB`.

## 2. Shared site-tie check

New on `SitesService` (already injected into `InspectionsService`; gains a
new injection into `InspectionRequestsService` and `MediaService`):

```typescript
async isTiedToSite(siteId: string, userId: string): Promise<boolean> {
  const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { contractorId: true } });
  if (!site) return false;
  if (site.contractorId === userId) return true;
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

`RealtimeGateway.resolveSiteIds` (Spec 2) has near-identical logic but is
deliberately **left as its own private method, not refactored to call
this** — it's already-shipped, already-verified code, and touching it here
for a pure DRY cleanup unrelated to this spec's actual goal isn't worth the
risk to something that already works. The small duplication is accepted.

## 3. `InspectionRequests` changes

- `@Roles()` on `POST /inspection-requests` and `PATCH /inspection-requests/:id`
  widens from `('contractor', 'administrator')` to
  `('contractor', 'developer', 'site_representative', 'administrator')`.
- `CreateInspectionRequestDto` **drops `contractorId` entirely.**
  `contractorId` is always derived server-side from `site.contractorId` —
  it can never drift from the site's actual contractor, and a developer/
  site-rep caller never had a `contractorId` of their own to begin with.
  `UpdateInspectionRequestDto`'s `OmitType(CreateInspectionRequestDto,
  ['contractorId'])` becomes plain `PartialType(CreateInspectionRequestDto)`
  since the field it was omitting no longer exists.
- `create()`/`update()` (when `dto.siteId` changes) both: look up the site,
  and for non-administrators call `sitesService.isTiedToSite(siteId,
  user.userId)` — reject with `ForbiddenException` if not tied. This closes
  the "any contractor can request against any site" gap while also being
  exactly the check developer/site-representative callers need.
- `findAll()`, `assertCanRead`, `assertCanEdit`: the existing `canSeeAll()`
  bypass (engineer or administrator sees every request, unrelated to site
  ties — engineers need this to find unclaimed pending requests) is
  **unchanged**. Only the *else* branch changes: the current scoping rule
  (`request.contractorId === user.userId`) is replaced with
  `sitesService.isTiedToSite(request.siteId, user.userId)` (via
  `resolveTiedSiteIds` for the list case). This is required, not
  incidental: once `contractorId` is always the site's real contractor
  rather than "whoever's own id happens to match," a developer or
  site-representative who created a request would otherwise never be able
  to see their own request again under the old rule.

## 4. `Inspections` changes

- `findOne`/`update`/`submit` gain the same tie check: administrator, the
  assigned engineer (`inspection.engineerId === user.userId`), or
  `sitesService.isTiedToSite(inspection.siteId, user.userId)` — anyone
  else gets 403. `findOne` needs `@CurrentUser()` added to the controller
  (it currently takes no user at all).
- `findAll()`: administrators get every inspection; everyone else gets
  `WHERE siteId IN (resolveTiedSiteIds(user)) OR engineerId = user.userId`
  — an engineer who isn't tied to a site but has an inspection assigned to
  them still sees that one.
- `update()`/`submit()` DTOs swap `checklistResponses`/`notes`/
  `observations`/`recommendations` for the single `notes` field (§1).

## 5. `Media` changes

`MediaModule` gains a `SitesModule` import (no cycle risk — `SitesModule`
doesn't depend on `MediaModule`). New shared check in `MediaService`:

```typescript
private async assertCanView(inspection: Inspection, user: AuthenticatedUser) {
  if (user.roles.includes('administrator')) return;
  if (inspection.engineerId === user.userId) return;
  if (!(await this.sitesService.isTiedToSite(inspection.siteId, user.userId))) {
    throw new ForbiddenException('You do not have access to this inspection');
  }
}
```

Applied in `findAllForInspection` (look up the inspection first, currently
skipped entirely) and `getFileStream` (look up the inspection via the
media's `inspectionId`, currently skipped entirely). Both controller methods
gain `@CurrentUser()`. Upload and delete are unchanged — already correctly
restricted to the assigned engineer or an administrator.

## 6. Frontend: `usePermissions.ts`

`developer`'s entry changes from a straight copy of `administrator`'s full
permission list (with a comment noting it was a placeholder) to:
`['view_sites', 'view_inspections', 'create_inspection_requests',
'view_reports']` — matching the backend's actual scope for this role.
`site_representative` gains `'create_inspection_requests'` (currently
missing, and now required — see §3). Site-creation permissions for
`developer` are explicitly **not** decided here; Spec 4 (site registration
modal) will settle that when it actually builds the create-site flow.

## 7. Frontend: `QuickActions.tsx`

"Start Inspection" only renders when `checkPermission(roles,
'perform_inspections')` is true (engineer, administrator). "New Request"
only renders when `checkPermission(roles, 'create_inspection_requests')`
is true (contractor, developer, site_representative, administrator). "View
Sites" and "Reports" stay unconditional — nothing in this spec restricts
them. `PendingRequests.tsx` needs no visibility change: it already renders
whatever `GET /inspection-requests` returns, and that endpoint's scoping fix
(§3) is what makes it correctly show "your site's requests" per role — no
separate frontend gate needed there.

## 8. Frontend: inspection form rewrite

New dependencies: `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`.

`InspectionForm.tsx`: removes `defaultChecklist`, the `checklist` state, and
the whole checklist `Card`/`RadioGroup` block. Adds a Tiptap editor
(`useEditor` with `StarterKit`) for `notes`, bound the same way `observations`
etc. currently are (seeded from `currentInspection.notes` on load, read on
save/submit). Risk Level `Select` is unchanged. Adds a Photos section below
the editor: a file input triggering upload, and a thumbnail grid — both
driven by new endpoints added to `inspectionsApi.ts`:

```typescript
getInspectionMedia: builder.query<Media[], string>            // GET /inspections/:id/media
uploadInspectionMedia: builder.mutation<Media, {inspectionId, file, latitude, longitude, caption?}>  // POST, multipart
deleteMedia: builder.mutation<void, string>                    // DELETE /media/:id
```

`ChecklistItem` type and the `checklist_responses`/`observations`/
`recommendations` fields on `Inspection`/`BackendInspection` are removed;
`notes` changes from `string` to the Tiptap JSON document type (`object`).
`SaveInspectionDraftPayload`/`SubmitInspectionPayload` drop
`checklistResponses`/`observations`/`recommendations`, keep `notes` (now
the document) and `riskLevel`.

## 9. Testing

No automated tests, consistent with the rest of the project. Manual
verification: curl-based authorization checks (a user with no tie to a
site gets 403 from the new endpoints/checks; a tied developer/contractor/
engineer gets 200), and a browser check of the rewritten inspection form
(Tiptap renders and saves, photo upload/list/delete works, "Start
Inspection"/"New Request" tiles show correctly per role).
