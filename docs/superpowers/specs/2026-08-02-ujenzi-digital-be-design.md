# ujenzi-digital-be design

Date: 2026-08-02

## Purpose

Backend for the SiteSight Pro / Ujenzi Digital construction-site inspection app
(currently `sitesight-pro`, a React + Supabase frontend). Supabase's schema,
RLS policies, and auth are being reimplemented as a standalone NestJS +
Prisma + Postgres service, so the frontend can eventually swap its Supabase
client for this API.

This repo started from `ujenzi-digital`, a bare `nest generate resource`
scaffold with `auth`/`users` module stubs and these packages already
installed but unused: `@nestjs/jwt`, `passport`, `passport-jwt`,
`passport-local`, `passport-google-oauth20`, `bcrypt`, `helmet`,
`csrf-csrf`, `@nestjs/throttler`. It was renamed to `ujenzi-digital-be` and
the stub modules are being replaced with real implementations.

## Scope (v1)

Full Supabase schema surface: users/roles, sites, inspection requests,
inspections (with checklist responses), media uploads, PDF reports,
inspection templates, and audit logs. No automated tests in this pass
(explicit call — can be layered on later).

## 1. Architecture

Modular monolith. One module per domain: `Auth`, `Users`, `Sites`,
`InspectionRequests`, `Inspections`, `Media`, `Reports`, `Templates`,
`AuditLog`, plus a global `PrismaModule`.

Global `ValidationPipe` (whitelist + transform), `helmet()`, CORS locked to
the sitesight-pro frontend origin with `credentials: true` (required for the
refresh cookie), rate limiting via `@nestjs/throttler` on `/auth/*`.

A global `HttpExceptionFilter` normalizes error responses to
`{ statusCode, message, error }`. Ownership/role failures → 403,
not-found → 404, validation → 400.

## 2. Auth & RBAC

- **User** merges what Supabase split across `auth.users` + `profiles`:
  email, bcrypt `passwordHash` (nullable — Google-only accounts have none),
  name, phone, company, certificationDetails, avatarUrl, status, nullable
  `googleId`.
- **UserRole**: `(userId, role)` unique pairs. A user can hold multiple
  roles, same as Supabase's `user_roles` table.
- **Signup (email/password)**: user selects role(s) on the signup form;
  password is bcrypt-hashed; roles are active immediately.
- **Google OAuth**: first login via Google creates the account with zero
  roles; the callback response includes `needsRoleSelection: true`. A
  follow-up `POST /auth/complete-profile` sets the initial role(s). Every
  guarded route requires ≥1 role, so a Google account can authenticate but
  can't hit any real endpoint until that step completes.
- **Tokens — hybrid pattern**:
  - *Access token*: JWT, 15 min TTL, payload includes `sub` + `roles[]`.
    Returned in the JSON login/refresh response body; frontend holds it in
    memory and sends it as `Authorization: Bearer`. `RolesGuard` reads
    roles straight off this token — no DB hit per request. Role edits by an
    admin take effect within one 15-minute window.
  - *Refresh token*: JWT, 7 day TTL, set as an `httpOnly`, `secure`,
    `sameSite=lax` cookie. Hashed and stored in a `RefreshToken` table for
    revocation. Rotate-on-use: each `/auth/refresh` call invalidates the old
    token, issues a new one, and re-reads roles fresh from the DB.
  - *CSRF*: only `/auth/refresh` and `/auth/logout` are cookie-authenticated,
    so `csrf-csrf` double-submit protection is scoped to just those two
    routes. Everything else is stateless Bearer auth and isn't
    CSRF-vulnerable.
- **RBAC guard**: `@Roles('administrator', 'engineer')` decorator + a
  `RolesGuard` checking decoded access-token roles against the route's
  required roles — the NestJS equivalent of Supabase's `has_role()`.

## 3. Data model (Prisma)

```prisma
enum AppRole {
  engineer
  contractor
  site_representative
  administrator
}

enum InspectionRequestStatus {
  pending
  accepted
  rejected
  completed
  in_progress
}

enum InspectionStatus {
  draft
  in_progress
  submitted
}

enum RiskLevel {
  low
  medium
  high
  critical
}

model User {
  id                   String   @id @default(uuid())
  email                String   @unique
  passwordHash         String?
  googleId             String?  @unique
  name                 String
  phone                String?
  company              String?
  certificationDetails String?
  avatarUrl            String?
  status               String   @default("active") // active | inactive
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  roles            UserRole[]
  refreshTokens    RefreshToken[]
  sitesOwned       Site[]              @relation("ContractorSites")
  requestsMade     InspectionRequest[] @relation("ContractorRequests")
  requestsAssigned InspectionRequest[] @relation("EngineerRequests")
  inspections      Inspection[]
  auditLogs        AuditLog[]
}

model UserRole {
  id     String  @id @default(uuid())
  userId String
  role   AppRole
  user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, role])
}

model RefreshToken {
  id        String    @id @default(uuid())
  userId    String
  tokenHash String
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Site {
  id                String   @id @default(uuid())
  name              String
  contractorId      String
  latitude          Decimal  @db.Decimal(10, 8)
  longitude         Decimal  @db.Decimal(11, 8)
  geofenceRadius    Int      @default(100)
  address           String
  constructionPhase String?
  status            String   @default("active") // active | inactive
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  contractor  User                @relation("ContractorSites", fields: [contractorId], references: [id])
  requests    InspectionRequest[]
  inspections Inspection[]
}

model InspectionRequest {
  id            String                  @id @default(uuid())
  siteId        String
  contractorId  String
  engineerId    String?
  requestedDate DateTime                @db.Date
  status        InspectionRequestStatus @default(pending)
  notes         String?
  createdAt     DateTime                @default(now())
  updatedAt     DateTime                @updatedAt

  site        Site         @relation(fields: [siteId], references: [id], onDelete: Cascade)
  contractor  User         @relation("ContractorRequests", fields: [contractorId], references: [id])
  engineer    User?        @relation("EngineerRequests", fields: [engineerId], references: [id])
  inspections Inspection[]
}

model Inspection {
  id                 String            @id @default(uuid())
  requestId          String
  siteId             String
  engineerId         String
  startTime          DateTime?
  endTime            DateTime?
  latitude           Decimal?          @db.Decimal(10, 8)
  longitude          Decimal?          @db.Decimal(11, 8)
  checklistResponses Json              @default("[]") // [{ id, question, category, response, notes }]
  notes              String?
  observations       String?
  riskLevel          RiskLevel?
  recommendations    String?
  status             InspectionStatus  @default(draft)
  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt

  request  InspectionRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  site     Site              @relation(fields: [siteId], references: [id])
  engineer User              @relation(fields: [engineerId], references: [id])
  media    Media[]
  reports  Report[]
}

model Media {
  id           String   @id @default(uuid())
  inspectionId String
  type         String   // photo | video
  url          String
  latitude     Decimal? @db.Decimal(10, 8)
  longitude    Decimal? @db.Decimal(11, 8)
  caption      String?
  createdAt    DateTime @default(now())

  inspection Inspection @relation(fields: [inspectionId], references: [id], onDelete: Cascade)
}

model Report {
  id                String   @id @default(uuid())
  inspectionId      String
  pdfUrl            String?
  engineerSignature String?
  submissionDate    DateTime @default(now())
  version           Int      @default(1)
  createdAt         DateTime @default(now())

  inspection Inspection @relation(fields: [inspectionId], references: [id], onDelete: Cascade)
}

model InspectionTemplate {
  id             String   @id @default(uuid())
  name           String
  description    String?
  checklistItems Json     @default("[]")
  createdBy      String?
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}

model AuditLog {
  id         String   @id @default(uuid())
  userId     String?
  action     String
  entityType String
  entityId   String?
  details    Json?
  ipAddress  String?
  createdAt  DateTime @default(now())

  user User? @relation(fields: [userId], references: [id])
}
```

`checklistResponses` and `checklistItems` stay as `Json`, matching the
original JSONB shape, rather than normalizing into their own tables — this
keeps behavior identical to what the frontend already sends/expects.

## 4. Authorization matrix (application-layer, replacing RLS)

| Resource | Read | Create | Update | Delete |
|---|---|---|---|---|
| Sites | any authenticated user | contractor (self) or administrator (any contractor) | owning contractor or administrator | owning contractor or administrator |
| InspectionRequests | owning contractor, assigned engineer, any engineer, or administrator | contractor (self) or administrator | owning contractor, assigned engineer, any engineer, or administrator | — (no delete in original schema) |
| Inspections | any authenticated user | engineer (self) or administrator | owning engineer or administrator | — |
| Media | any authenticated user | engineer who owns the parent inspection, or administrator | — | engineer who owns the parent inspection, or administrator |
| Reports | any authenticated user | engineer who owns the parent inspection, or administrator | engineer who owns the parent inspection, or administrator | — |
| InspectionTemplates | everyone sees active ones; administrator also sees inactive | administrator only | administrator only | administrator only |
| AuditLogs | administrator only | internal only (service calls, not a public endpoint) | — | — |
| Users/roles | own profile + roles, or administrator sees all | signup (self) | own profile fields (self); roles: administrator only | — |

### Deliberate deviations from the literal Supabase RLS policies

1. Supabase's `WITH CHECK` on site/request INSERT required
   `contractor_id = auth.uid()` even for administrators — an admin could
   only ever create a site "as themselves." This is relaxed: administrators
   may specify any `contractorId` when creating a site or inspection
   request, since "admin creates on behalf of a contractor" is a normal
   admin task that the original policy actually blocked.
2. Audit log inserts are internal (`AuditLogService.log()` called from
   within other services on sensitive mutations — site/request/inspection
   changes, role changes, status changes), not a public `POST /audit-logs`
   endpoint. The Supabase policy allowed any authenticated user to insert,
   which only worked because Supabase's own code was the sole caller.

## 5. Media

`POST /inspections/:id/media` via NestJS `FileInterceptor` (multer):
validates mime type (`image/*` or `video/*`) and a size cap (25MB),
generates a UUID filename, saves to `uploads/media/` on local disk
(gitignored), stores the relative path in `Media.url`. Files are served
through an authenticated `GET /media/:id/file` streaming endpoint rather
than a static mount, so the same read-authorization rule applies before
bytes go out. Storage access goes through a `StorageService` interface
(`save`, `read`, `delete`) so swapping to S3-compatible storage later is a
single adapter, not a rewrite.

## 6. Reports (PDF)

`POST /inspections/:id/report`: `ReportsService` loads the inspection, its
checklist responses, media, and engineer signature; renders an HTML
template (checklist table, photos, risk level, signature); converts it to
PDF with Puppeteer; saves it to `uploads/reports/`; stores the path in
`Report.pdfUrl`. If a report already exists for that inspection, the new
one increments `version` rather than overwriting.

## 7. Audit logging

`AuditLogService.log(userId, action, entityType, entityId, details, ip)`
called explicitly from the service methods that mutate sites, inspection
requests, inspections, user roles, and user status. `GET /audit-logs` is
administrator-only, filterable by entity/user/date.

## 8. Infra & config

- `docker-compose.yml`: single `postgres` service + named volume for local
  dev.
- `.env`: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
  `COOKIE_SECRET`, `CSRF_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_CALLBACK_URL`, `FRONTEND_ORIGIN`, `PORT`.
- Prisma Migrate manages schema changes (`prisma migrate dev`).

## 9. Testing

None in this pass — explicit call to keep scope to the working API first.
Can be layered on in a later pass.
