# Site Registration Modal design

Date: 2026-08-14

## Purpose

Spec 4 of the 6-spec sequence. Replicates the *intent* of the Ujenzi Digital
Portal's site-registration dialog in sitesight-pro — not a literal port.
Investigation found the portal's component is incompatible on every axis
that matters: its personnel role vocabulary doesn't match the backend enum
(missing `ENGINEER`, uses `DEVELOPER_REPRESENTATIVE` instead of
`SITE_REPRESENTATIVE`), its personnel entry shape (`{fullName, email,
phone, role}`) matches neither backend variant (`{role, userId}` or
`{role, name, contact}`), its POST payload nests `location: {lat, lng}`
where the backend wants flat fields, it has an `expectedEndDate` field the
backend doesn't have, and its tech stack (React 19, `@base-ui/react`,
Tailwind 4, zod 4, `react-router`) is a different major version of nearly
everything sitesight-pro uses (React 18, Radix, Tailwind 3, zod 3.25,
`react-router-dom`). This spec rebuilds the form against sitesight-pro's
own stack and the backend's actual contract, using the portal purely as a
field-set and UX reference.

## 1. Backend: `expectedEndDate`

`Site` gains `expectedEndDate DateTime?`. `CreateSiteDto`/`UpdateSiteDto`
gain `expectedEndDate?: string` (`@IsOptional() @IsDateString()`), same
pattern as `InspectionRequest.requestedDate`. Plain column addition,
ordinary `prisma migrate dev`.

## 2. Backend: `developer` can register and edit sites

`@Roles()` on `POST /sites` and `PATCH /sites/:id` widens from
`('contractor', 'administrator')` to `('contractor', 'developer',
'administrator')`.

**`contractorId` derivation** (`SitesService.resolveContractorId`,
`create()` only — `update()` never touches `contractorId`, it's immutable
after creation): a `contractor` caller still becomes their own
`contractorId` (unchanged); an `administrator` still must supply an
explicit `contractorId` (unchanged); a `developer` caller has no
`contractorId` of their own, so it's derived from the submitted
`personnel` array — it must contain a `CONTRACTOR`-role entry with a
linked `userId` (not a freeform contact), or the request is rejected with
`BadRequestException`. This mirrors the portal's own intent (personnel
must include a contractor-side person) while actually enforcing it, which
the portal never did server-side.

**Edit access broadens correspondingly**: `assertOwnerOrAdmin` (used by
`update()`/`remove()`) becomes async and also allows a linked (`userId`-based)
`SitePersonnel` entry with role `DEVELOPER` for that site, in addition to
the existing `contractorId`-match and administrator checks. Without this, a
developer who registers a site could never edit it again — the create
half of this feature would be useless without the edit half.

`site_representative` is **not** added to either check in this spec — not
requested, and adding it without a concrete need would be scope creep.

## 3. Backend: `GET /users/lookup`

New route on the existing `UsersController`, no `@Roles()` (any
authenticated user, matching the global `JwtAuthGuard` default):

```
GET /users/lookup?email=jane@example.com
  200 { id, name }   — a user with that email exists
  404                — no match; frontend falls back to freeform contact entry
```

New `LookupUserDto` (`{ email: string }`, `@IsEmail()`) and
`UsersService.lookupByEmail(email)`. This exists solely so the site
registration form can resolve "link an existing account" without needing
`GET /users` (admin-only) — it returns only `{id, name}`, nothing else
about the user.

## 4. Frontend: component structure

New directory `src/components/sites/`, split by responsibility rather
than one large file:

- **`SiteRegistrationDialog.tsx`** — the `Dialog` + `react-hook-form` +
  zod orchestration. Takes an optional `site` prop: absent → create mode
  (`POST /sites`); present → edit mode (`PATCH /sites/:id`), form
  pre-filled from the existing record.
- **`SitePersonnelField.tsx`** — the personnel `useFieldArray`. Each row:
  a role `Select` (the 5 backend `SitePersonnelRole` values), then a
  toggle between "Link account" (email input + a "Look up" button calling
  `GET /users/lookup`, showing the resolved name or an inline "not found"
  error) and "Freeform contact" (name + contact inputs). No zod-level
  minimum-personnel or role-composition requirement is enforced for
  general create/edit — the backend itself only requires a specific
  personnel shape in the one case that actually needs it (a `developer`
  caller must include a linked `CONTRACTOR`, per §2), and that path
  already gets a clear `400` from the server if violated. Adding a
  client-side rule on top that's stricter than the API it submits to would
  just create a second, inconsistent source of truth — so this form
  validates shape (each entry has exactly one of a linked account or
  freeform name+contact) but not roster composition.
- **`SiteApprovalsField.tsx`** — county/NEMA/NCA blocks, each an optional
  `{status, reference}` pair, matching `SiteApprovalsDto` exactly.
- **`SiteLandmarksField.tsx`** — dynamic add/remove string list (badges),
  adapted from the portal's existing pattern for this one field, since
  that part of the portal's UI has no backend-shape mismatch to fix.

Full field set on the form: name, address, expectedEndDate,
developmentType (5-value select), country, county (ported flat
`KENYA_COUNTIES` string list — the portal's version has no
constituency-nesting to lose), constituency, town, plotNumber, latitude/
longitude (numeric inputs + the existing `useGeolocation` hook's "Use
Current Location", matching sitesight-pro's current convention — not the
portal's string+regex approach), geofenceRadius (unchanged: default 500,
min 50/max 2000), landmarks, approvals, personnel.

## 5. Frontend: wiring and removed page

- `Sites.tsx`'s `<Link to="/sites/new">Add Site</Link>` (both occurrences —
  the header button and the empty-state one) becomes a `<Dialog>` wrapping
  `<SiteRegistrationDialog />`, no `site` prop (create mode).
- `SiteDetail.tsx`'s existing "Edit Site" `<Button>` (currently has no
  `onClick`) opens the same dialog with `site={currentSite}` (edit mode).
- `/sites/new` route removed from `App.tsx`; `SiteCreate.tsx` deleted.
- `sitesApi.ts`'s `Site`/`CreateSitePayload`/`UpdateSitePayload` gain the
  full field set (flat lat/lng unchanged, `geofenceRadius`,
  `developmentType`, `country`/`county`/`constituency`/`town`/
  `plotNumber`, `expectedEndDate`, `landmarks`, `approvals`, `personnel`).
- `usersApi.ts` gains the email-lookup query (`lookupUserByEmail`).

## 6. Testing

No automated tests, consistent with the rest of the project. Backend:
curl-based checks that a developer without a `CONTRACTOR` personnel entry
gets `400`, one with a linked-account `CONTRACTOR` entry succeeds with the
right `contractorId`, and that the resulting developer can then `PATCH`
the site while an unrelated developer cannot. Frontend: browser
verification that the dialog opens from both trigger points, all field
sections render and submit correctly in both create and edit mode, and the
personnel email-lookup round-trips against the real endpoint.
