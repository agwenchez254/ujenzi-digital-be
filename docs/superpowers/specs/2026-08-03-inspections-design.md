# Inspections design

Date: 2026-08-03

## Purpose

Third vertical slice of `ujenzi-digital-be`, following Sites + InspectionRequests
(`docs/superpowers/plans/2026-08-03-sites-inspection-requests.md`, fully
implemented). Implements the `Inspections` module from the overall design
(`2026-08-02-ujenzi-digital-be-design.md`, §3-4) — the module where the
`accepted → in_progress → completed` `InspectionRequest` transitions actually
happen, and where `SitesService.isWithinGeofence()` (built in the previous
slice but never called) gets its call site. Media and Reports (§5-6) remain
out of scope — separate future slices.

## 1. Data model

No schema changes. `Inspection` already has every field needed
(`requestId`, `siteId`, `engineerId`, `startTime`, `endTime`, `latitude`,
`longitude`, `checklistResponses` (Json), `notes`, `observations`,
`riskLevel`, `recommendations`, `status`).

`InspectionStatus` stays `draft | in_progress | submitted` (already committed
enum). This slice only produces `in_progress` and `submitted` — `draft` has
no code path in this pass. `POST /inspections` ("Start Inspection", matching
the frontend's actual behavior) creates the row directly as `in_progress`
rather than `draft`, since the frontend never exercises a separate
draft-then-begin step.

## 2. Inspections module

| Route | Access | Notes |
|---|---|---|
| `GET /inspections` | any authenticated user | No pagination, matching the rest of the API. Nested `site: { id, name, address }`, `engineer: { id, name } `. |
| `GET /inspections/:id` | any authenticated user | Same shape, single record. 404 if missing. |
| `POST /inspections` | engineer or administrator | Body: `{ requestId, latitude, longitude }`. See §3 for the start rules. |
| `PATCH /inspections/:id` | owning engineer or administrator | Only while `status === 'in_progress'`. Body: `notes?`, `observations?`, `checklistResponses?`, `riskLevel?`, `recommendations?`. |
| `POST /inspections/:id/submit` | owning engineer or administrator | Only while `status === 'in_progress'`. Body: `{ latitude, longitude, notes?, observations?, checklistResponses?, riskLevel?, recommendations? }`. See §3 for the submit rules. |

No delete endpoint — the authorization matrix (§4 of the overall design) has
no delete row for Inspections.

`engineerId` is never supplied by the caller. Unlike `Sites` and
`InspectionRequests`, where an administrator can act "on behalf of" any
contractor/engineer, an Inspection's `engineerId` is always derived from the
`InspectionRequest.engineerId` it starts from — there is no scenario where an
administrator performs a physical site inspection as a stand-in for a
different engineer, so there's nothing for a caller-supplied `engineerId` to
express. This is a deliberate simplification versus copying the Sites/
InspectionRequests pattern verbatim.

## 3. Business rules

**Starting an inspection (`POST /inspections`):**

1. Load the `InspectionRequest` by `requestId`; 404 if missing.
2. `request.status` must be `accepted`; otherwise `409 Conflict`.
3. Caller must be `request.engineerId` (the assigned engineer) or hold the
   `administrator` role; otherwise `403 Forbidden`.
4. Load the request's `Site`; call
   `sitesService.isWithinGeofence(dto.latitude, dto.longitude, site)`. If
   `false`, `403 Forbidden` ("Outside the site's geofence").
5. Create the `Inspection`: `requestId`, `siteId` (copied from the request),
   `engineerId` (copied from `request.engineerId`), `status: in_progress`,
   `startTime: now()`, `latitude`/`longitude` from the body.
6. Update `InspectionRequest.status` to `in_progress`.
7. Audit log `inspection.started`.

**Editing a draft-in-progress inspection (`PATCH /inspections/:id`):**

1. Load the `Inspection`; 404 if missing.
2. Caller must be `inspection.engineerId` or `administrator`; otherwise `403`.
3. `inspection.status` must be `in_progress`; otherwise `403` ("This
   inspection can no longer be edited").
4. Apply whichever of `notes`/`observations`/`checklistResponses`/
   `riskLevel`/`recommendations` were provided.
5. Audit log `inspection.updated`.

**Submitting an inspection (`POST /inspections/:id/submit`):**

1. Load the `Inspection`; 404 if missing.
2. Same ownership check as PATCH.
3. `inspection.status` must be `in_progress`; otherwise `409 Conflict`
   ("Only an in-progress inspection can be submitted").
4. Load the `Inspection`'s `Site`; geofence-check `dto.latitude`/
   `dto.longitude` the same way as start — `403` if outside radius.
5. Apply any final `notes`/`observations`/`checklistResponses`/`riskLevel`/
   `recommendations` provided in the body, plus `latitude`/`longitude`,
   `endTime: now()`, `status: submitted`.
6. Update the parent `InspectionRequest.status` to `completed`.
7. Audit log `inspection.submitted`.

Steps 5-6 of both start and submit (the `Inspection` write and the
`InspectionRequest` status update) run inside a single `prisma.$transaction`
so a request can never be left `in_progress`/`completed` without a matching
`Inspection` row, or vice versa.

## 4. DTOs

- `CreateInspectionDto`: `requestId` (UUID), `latitude` (latitude-validated
  number), `longitude` (longitude-validated number).
- `UpdateInspectionDto`: `notes?`, `observations?`, `recommendations?`
  (strings), `riskLevel?` (`RiskLevel` enum), `checklistResponses?`
  (array of `{ id, question, category, response, notes? }`, all strings —
  kept loosely typed to match the original design's decision to leave this
  field as flexible JSON rather than a normalized/strictly-typed shape).
- `SubmitInspectionDto`: extends `UpdateInspectionDto` plus required
  `latitude`/`longitude`.
- `checklistResponses`, when provided on `PATCH`/`submit`, replaces the
  entire array — there is no item-level merge. This matches how every other
  optional field in this API is treated (whatever's provided overwrites the
  existing column outright) and avoids inventing new merge semantics for
  this one field.

## 5. Swagger

Decorated inline on the new DTOs/controller (`@ApiTags('Inspections')`,
`@ApiBearerAuth()`, `@ApiOperation()` per route, `@ApiProperty()`/
`@ApiPropertyOptional()` per DTO field), consistent with the Sites/
InspectionRequests slice. No retroactive work needed elsewhere.

## 6. Testing

None in this pass, consistent with the rest of the project (design spec §9)
— manual `curl` verification per task.
