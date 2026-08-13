# Role permissions + admin user management design

Date: 2026-08-04

## Purpose

Today, `sitesight-pro`'s `usePermissions.ts` hardcodes a
`Record<AppRole, Permission[]>` map client-side — the only way to change what
a role can do is to edit and redeploy the frontend. This moves that mapping
to the backend (`ujenzi-digital-be`), makes it editable by administrators at
runtime, and surfaces each user's resolved permissions on their auth token
(mirroring how `roles` already works). It also redesigns the admin "Users"
page from a card list into a data-table with CRUD-style row actions,
including a shortcut into the new role-permission editor.

This builds on the existing RBAC work documented in
`2026-08-02-ujenzi-digital-be-design.md` (roles, JWT strategy) — read that
first for the auth/token baseline this extends.

## Scope decisions

Three scope forks were deliberately narrowed during design, each with a
reason worth keeping visible:

1. **Per-role, not per-user permissions.** An admin edits what a *role*
   grants (e.g. toggle `create_sites` for `contractor`), and every user with
   that role inherits the change. No per-user permission overrides — that
   would need a second `UserPermission` table plus override-resolution logic
   (does a user override beat their role's default?) for a need nobody has
   surfaced yet.
2. **UI-gating only — backend enforcement is unchanged.** Every existing
   `@Roles(...)` guard on every controller stays exactly as-is. Permissions
   are a new, separate, additive concept whose only consumer is the frontend
   deciding what to show/hide. This keeps zero risk to currently-working
   authorization; wiring permissions into backend enforcement is a future
   decision, not this one.
3. **Fixed permission catalog, dynamic assignment.** The 13 permission
   strings (`view_sites`, `create_sites`, ... `view_audit_logs`) stay a fixed
   list defined in code on both sides, matching the existing convention for
   `AppRole` (also duplicated BE/FE, not database-driven). What becomes
   dynamic is only *which permissions each role currently has* — inventing
   arbitrary new permission strings via a UI wouldn't correspond to any
   actual `hasPermission()` check in the code, so the catalog itself isn't a
   thing admins edit.

## 1. Backend: `RolePermission` model + admin API

```prisma
model RolePermission {
  id         String  @id @default(uuid())
  role       AppRole
  permission String

  @@unique([role, permission])
}
```

Seeded via migration with the exact mapping `usePermissions.ts` hardcodes
today, so cutover doesn't change anyone's visible capabilities:

- `administrator`, `developer`: all 13 permissions
- `engineer`: `view_sites`, `view_inspections`, `accept_inspection_requests`,
  `perform_inspections`, `view_reports`, `create_reports`
- `contractor`: `view_sites`, `create_sites`, `edit_sites`, `delete_sites`,
  `view_inspections`, `create_inspection_requests`, `view_reports`
- `site_representative`: `view_sites`, `view_inspections`, `view_reports`

New `PermissionsModule`:

- `GET /roles/permissions` (administrator-only) — returns the full
  `{ role: permission[] }` map, for the admin editor.
- `PUT /roles/:role/permissions` (administrator-only) — replaces one role's
  permission set wholesale (full-list replace, matching how role
  reassignment already works in `UsersService.updateRoles`). Audit-logged
  via `AuditLogService` the same way role/status changes already are.

## 2. Backend: token claims

`AuthService.issueTokens` currently resolves `roles` for a user and embeds
`{sub, roles}` in the access token, returning `user: {...safeUser, roles}` in
every `AuthResult` (signup/login/refresh/complete-profile/google). It now
also resolves the deduped union of `RolePermission` rows across all of that
user's roles, and threads it through the same way: access token payload
becomes `{sub, roles, permissions}`, and `user.permissions: string[]` is
added to every `AuthResult`.

This inherits the same staleness trade-off already accepted for roles: a
permission change takes effect for an affected user within one 15-minute
access-token cycle, not instantly. No new caveat — consistent with the
existing design.

`AuthenticatedUser` (what `@CurrentUser()` injects) also gains a
`permissions: AppRole[]` field for consistency, even though nothing enforces
on it yet (see scope decision #2).

## 3. Backend: admin profile-edit endpoint

`PATCH /users/:id` (administrator-only) — profile fields only (`name`,
`phone`, `company`, `certificationDetails`), reusing the same
`UpdateProfileDto` shape `PATCH /users/me` already uses. Today only the
self-service `PATCH /users/me` exists; this is the admin-on-behalf-of-another
equivalent, mirroring `UsersService.updateSelf`.

## 4. Frontend: permissions consumption

- `authSlice.ts`'s `AuthState` gains `permissions: Permission[]`, populated
  in `sessionEstablished`/`profileUpdated` straight from `user.permissions`
  on the token/`AuthResult` — the same mechanism already populating `roles`.
- `usePermissions.ts`: `hasPermission` changes signature from
  `(userRoles: AppRole[], permission)` to
  `(userPermissions: Permission[], permission)` and becomes a plain
  `.includes()` check. The hardcoded `rolePermissions` map is deleted
  entirely — that's the actual point of this change.
- Four call sites switch from reading `roles` to reading `permissions` off
  the same `state.auth` selector they already use: `Sites.tsx`,
  `SiteDetail.tsx`, `Inspections.tsx`, `DesktopSidebar.tsx`.
- `hasAnyRole`/`checkRole` (role-based, used for page-level route gating in
  `ProtectedRoute`'s `allowedRoles`) are untouched — that's a separate
  concern (which pages exist at all for a role) from in-page permission
  checks (which buttons/actions show up), and stays role-based.
- New `rolePermissionsApi.ts` (RTK Query): `getRolePermissions` query +
  `updateRolePermissions` mutation, following the same
  `baseApi.injectEndpoints` / tag-invalidation pattern as `usersApi.ts`.

## 5. Frontend: `AdminUsers.tsx` redesign

Card list → data-table, built with the existing shadcn `Table`/`TableHeader`/
`TableRow`/`TableCell` primitives (already in this codebase) plus a row
actions `DropdownMenu` (also already in this codebase) — no new dependency.
`@tanstack/react-table` was considered and rejected: nothing here needs
column sorting/pagination at this scale, and no other list page in this app
uses a table-abstraction library either.

Columns: user (avatar + name + email), company, status badge, role badges,
actions.

Row actions:

- **Edit user** → dialog with profile fields only (name, phone, company,
  certification details) → `PATCH /users/:id` (section 3).
- **Assign role** / **Remove role: X** → kept as today's existing dropdown
  items, immediate mutation via `useUpdateUserRolesMutation` (unchanged).
- **Modify permissions** → opens the role×permission matrix (section 1),
  scoped to this user's role(s). If the user holds exactly one role, it goes
  straight to that role's checklist; if they hold multiple, a small picker
  appears first. The dialog copy makes explicit that this edits the *role's*
  permissions globally — every user sharing that role is affected, not just
  the one whose row you clicked through from.
- **Revoke** → deactivates the account (`status: 'inactive'`, same effect as
  today's Activate/Deactivate toggle), now behind a confirmation
  `AlertDialog` since it's an access-revoking action — matching the existing
  confirm-before-destroy pattern already used for site deletion in
  `SiteDetail.tsx`.

## Out of scope (deliberately)

- Backend authorization enforcement via permissions (scope decision #2).
- Per-user permission overrides (scope decision #1).
- A dynamic/admin-editable permission catalog (scope decision #3).
- Automated tests — consistent with the "no tests in this pass" call made
  for the rest of this backend to date.
