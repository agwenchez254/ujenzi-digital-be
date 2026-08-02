# Foundation, Auth & RBAC, Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the NestJS + Prisma + Postgres foundation (full schema, global middleware, error handling), then implement the hybrid JWT auth flow (signup, login, refresh rotation, Google OAuth, role selection) and RBAC guards, plus self-service and admin user management — the vertical slice everything else in the spec depends on.

**Architecture:** Modular monolith; one NestJS module per domain. `PrismaModule` and a new `CommonModule` are `@Global()`. Auth uses passport strategies (`local`, `jwt`, `google`) wired through NestJS guards. `JwtAuthGuard` + `RolesGuard` are registered as global `APP_GUARD`s so every route requires a valid access token and at least one role by default; `@Public()` opts a route out of both, `@AllowNoRole()` opts out of just the role check.

**Tech Stack:** NestJS 11, Prisma + PostgreSQL 16 (via Docker Compose), `@nestjs/jwt`, `@nestjs/passport` (`passport-local`, `passport-jwt`, `passport-google-oauth20`), `bcrypt`, `helmet`, `@nestjs/throttler`, `csrf-csrf`, `@nestjs/config`, `class-validator`/`class-transformer`, `cookie-parser`. Package manager is **pnpm**.

## Global Constraints

- No automated tests in this pass (explicit spec decision — section 9). Every task substitutes a manual verification step (build/typecheck + `pnpm run start:dev` + `curl`) for the usual test-first cycle.
- Modular monolith: one module per domain (`Auth`, `Users`, ... plus a global `PrismaModule`).
- Global `ValidationPipe({ whitelist: true, transform: true })`, `helmet()`, CORS locked to `FRONTEND_ORIGIN` with `credentials: true`, rate limiting via `@nestjs/throttler` scoped to `/auth/*` only.
- A global `HttpExceptionFilter` normalizes every error response to `{ statusCode, message, error }`.
- Access token: JWT, 15 min TTL, payload `{ sub, roles[] }`, returned in the JSON response body, sent by the frontend as `Authorization: Bearer`. Guards read roles off the token — no DB hit per request.
- Refresh token: JWT, 7 day TTL, `httpOnly` + `secure` (prod) + `sameSite=lax` cookie, hashed (SHA-256, for exact-match revocation lookups) and stored in `RefreshToken`, rotated on every use, re-reads roles fresh from the DB on rotation.
- CSRF (`csrf-csrf`, double-submit cookie) is scoped to exactly `/auth/refresh` and `/auth/logout` — everything else is stateless Bearer auth.
- Every guarded route requires ≥1 role except `/auth/complete-profile`, which a zero-role (fresh Google) account must be able to call.
- Prisma Migrate manages schema changes (`prisma migrate dev`).
- Package manager is `pnpm`, not `npm`/`yarn`.

---

## File Structure

```
docker-compose.yml
.env.example
prisma/
  schema.prisma
src/
  main.ts                                (rewrite)
  app.module.ts                           (rewrite)
  app.controller.ts                       (add @Public())
  prisma/
    prisma.module.ts
    prisma.service.ts
  common/
    common.module.ts
    filters/http-exception.filter.ts
    decorators/public.decorator.ts
    decorators/allow-no-role.decorator.ts
    decorators/roles.decorator.ts
    decorators/current-user.decorator.ts
    guards/jwt-auth.guard.ts
    guards/roles.guard.ts
    csrf/csrf.service.ts
    csrf/csrf.middleware.ts
  audit-log/
    audit-log.module.ts
    audit-log.service.ts
    audit-log.controller.ts
    dto/query-audit-log.dto.ts
  auth/
    auth.module.ts                        (rewrite)
    auth.controller.ts                    (rewrite)
    auth.service.ts                       (rewrite)
    types/jwt-payload.type.ts
    dto/signup.dto.ts
    dto/complete-profile.dto.ts
    strategies/jwt.strategy.ts
    strategies/local.strategy.ts
    strategies/google.strategy.ts
    guards/local-auth.guard.ts
    guards/google-auth.guard.ts
    (delete: dto/create-auth.dto.ts, dto/update-auth.dto.ts, entities/auth.entity.ts,
     auth.controller.spec.ts, auth.service.spec.ts)
  users/
    users.module.ts                       (rewrite)
    users.controller.ts
    users.service.ts
    dto/update-profile.dto.ts
    dto/update-status.dto.ts
    dto/update-roles.dto.ts
```

---

### Task 1: Docker Compose + full Prisma schema + initial migration

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `prisma/schema.prisma`
- Modify: `package.json` (add `prisma`, `@prisma/client`)

**Interfaces:**
- Produces: a running local Postgres on `localhost:5433` (mapped to the container's internal 5432 — 5432 is already taken by an unrelated container on this host) (db `ujenzi_digital`, user/pass `postgres`/`postgres`), a migrated schema with every model from the design spec, and a generated `@prisma/client` (exports `PrismaClient`, `AppRole`, `InspectionRequestStatus`, `InspectionStatus`, `RiskLevel`, `User`, `UserRole`, `RefreshToken`, `Site`, `InspectionRequest`, `Inspection`, `Media`, `Report`, `InspectionTemplate`, `AuditLog`, `Prisma` namespace).

- [ ] **Step 1: Install Prisma**

```bash
pnpm add @prisma/client
pnpm add -D prisma
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
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

- [ ] **Step 3: Create `.env.example`** (committed; real `.env` is gitignored already)

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ujenzi_digital?schema=public
JWT_ACCESS_SECRET=replace-with-a-long-random-string
JWT_REFRESH_SECRET=replace-with-a-different-long-random-string
CSRF_SECRET=replace-with-another-long-random-string
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
FRONTEND_ORIGIN=http://localhost:5173
PORT=3000
NODE_ENV=development
```

Copy it to a real `.env` for local dev:

```bash
cp .env.example .env
```

- [ ] **Step 4: Write `prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

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

- [ ] **Step 5: Start Postgres and run the initial migration**

```bash
docker compose up -d
pnpm exec prisma migrate dev --name init
```

Expected: Prisma prints `Your database is now in sync with your schema` and generates the client. Verify tables exist:

```bash
docker compose exec postgres psql -U postgres -d ujenzi_digital -c '\dt'
```

Expected: a table list including `User`, `UserRole`, `RefreshToken`, `Site`, `InspectionRequest`, `Inspection`, `Media`, `Report`, `InspectionTemplate`, `AuditLog`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example prisma package.json pnpm-lock.yaml
git commit -m "feat: add docker-compose postgres and full prisma schema"
```

---

### Task 2: PrismaModule + PrismaService

**Files:**
- Create: `src/prisma/prisma.service.ts`
- Create: `src/prisma/prisma.module.ts`

**Interfaces:**
- Consumes: `PrismaClient` from `@prisma/client` (Task 1).
- Produces: `PrismaService` (injectable, extends `PrismaClient`), `PrismaModule` (`@Global()`, exports `PrismaService`) — every later module injects `PrismaService` via constructor.

- [ ] **Step 1: Write `PrismaService`**

```typescript
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

- [ ] **Step 2: Write `PrismaModule`**

```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 3: Wire it into `AppModule` temporarily to verify it compiles**

Add `PrismaModule` to `AppModule`'s `imports` (the full `app.module.ts` rewrite happens in Task 4 — for now just add the import so the build step below actually exercises it):

```typescript
import { PrismaModule } from './prisma/prisma.module';
// ...
@Module({
  imports: [AuthModule, UsersModule, PrismaModule],
  ...
})
```

- [ ] **Step 4: Build and verify**

```bash
pnpm run build
```

Expected: compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/prisma src/app.module.ts
git commit -m "feat: add global PrismaModule/PrismaService"
```

---

### Task 3: Global middleware, pipes, error filter, config

**Files:**
- Create: `src/common/filters/http-exception.filter.ts`
- Modify: `src/main.ts`
- Modify: `package.json` (add `@nestjs/config`, `cookie-parser`, `class-validator`, `class-transformer`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `HttpExceptionFilter` (importable by `main.ts`), a bootstrap that applies `helmet()`, `cookie-parser`, CORS (`FRONTEND_ORIGIN`, `credentials: true`), a global `ValidationPipe({ whitelist: true, transform: true })`, and the global exception filter. `ConfigModule` becomes available for injection everywhere (wired into `AppModule` in Task 4).

- [ ] **Step 1: Install dependencies**

```bash
pnpm add @nestjs/config cookie-parser class-validator class-transformer
pnpm add -D @types/cookie-parser
```

- [ ] **Step 2: Write `HttpExceptionFilter`**

```typescript
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;

    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : ((exceptionResponse as { message?: string | string[] } | null)?.message ??
          'Internal server error');

    const error =
      exceptionResponse && typeof exceptionResponse === 'object'
        ? ((exceptionResponse as { error?: string }).error ?? HttpStatus[statusCode])
        : HttpStatus[statusCode];

    response.status(statusCode).json({ statusCode, message, error });
  }
}
```

- [ ] **Step 3: Rewrite `src/main.ts`**

```typescript
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.use(helmet());
  app.use(cookieParser());

  app.enableCors({
    origin: configService.get<string>('FRONTEND_ORIGIN'),
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
}
bootstrap();
```

- [ ] **Step 4: Temporarily add `ConfigModule.forRoot({ isGlobal: true })` to `AppModule`** (full rewrite in Task 4; for now, just enough to build and run)

```typescript
import { ConfigModule } from '@nestjs/config';
// ...
@Module({
  imports: [AuthModule, UsersModule, PrismaModule, ConfigModule.forRoot({ isGlobal: true })],
  ...
})
```

- [ ] **Step 5: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

In another terminal:

```bash
curl -i http://localhost:3000
```

Expected: `200 OK` with `Hello World!` body, and response headers show helmet headers (e.g. `x-content-type-options: nosniff`). Stop the dev server (Ctrl+C).

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/common src/app.module.ts package.json pnpm-lock.yaml
git commit -m "feat: add global helmet/cors/validation pipe/exception filter"
```

---

### Task 4: Auth building blocks — decorators, guards, AppModule wiring

**Files:**
- Create: `src/common/decorators/public.decorator.ts`
- Create: `src/common/decorators/allow-no-role.decorator.ts`
- Create: `src/common/decorators/roles.decorator.ts`
- Create: `src/common/decorators/current-user.decorator.ts`
- Create: `src/common/guards/jwt-auth.guard.ts`
- Create: `src/common/guards/roles.guard.ts`
- Create: `src/auth/types/jwt-payload.type.ts`
- Modify: `src/app.controller.ts` (mark root route `@Public()`)
- Modify: `src/app.module.ts` (final rewrite — global guards, throttler)
- Modify: `package.json` (add `@nestjs/throttler` is already installed; no new deps here)

**Interfaces:**
- Consumes: `AppRole` from `@prisma/client` (Task 1).
- Produces:
  - `AccessTokenPayload { sub: string; roles: AppRole[] }`, `AuthenticatedUser { userId: string; roles: AppRole[] }` (both consumed by Task 5 onward's strategies/guards/controllers).
  - `Public()`, `AllowNoRole()`, `Roles(...roles: AppRole[])` decorators and `CurrentUser()` param decorator.
  - `JwtAuthGuard`, `RolesGuard` registered as global `APP_GUARD`s.

- [ ] **Step 1: Write the auth payload types**

`src/auth/types/jwt-payload.type.ts`:

```typescript
import { AppRole } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string;
  roles: AppRole[];
}

export interface AuthenticatedUser {
  userId: string;
  roles: AppRole[];
}
```

- [ ] **Step 2: Write the decorators**

`src/common/decorators/public.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

`src/common/decorators/allow-no-role.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const ALLOW_NO_ROLE_KEY = 'allowNoRole';
export const AllowNoRole = () => SetMetadata(ALLOW_NO_ROLE_KEY, true);
```

`src/common/decorators/roles.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';
import { AppRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
```

`src/common/decorators/current-user.decorator.ts`:

```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/types/jwt-payload.type';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.user as AuthenticatedUser;
  },
);
```

- [ ] **Step 3: Write `JwtAuthGuard`**

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}
```

- [ ] **Step 4: Write `RolesGuard`**

```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/types/jwt-payload.type';
import { ALLOW_NO_ROLE_KEY } from '../decorators/allow-no-role.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) {
      return false;
    }

    const allowNoRole = this.reflector.getAllAndOverride<boolean>(ALLOW_NO_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowNoRole) {
      return true;
    }

    if (user.roles.length === 0) {
      throw new ForbiddenException('Account has no assigned roles yet');
    }

    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    return requiredRoles.some((role) => user.roles.includes(role));
  }
}
```

- [ ] **Step 5: Mark the existing root route `@Public()`**

Edit `src/app.controller.ts` — add the import and decorator to the existing `getHello()` handler:

```typescript
import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
```

- [ ] **Step 6: Rewrite `src/app.module.ts`** with global guards and throttler (Auth/Users/AuditLog modules referenced here are filled in by later tasks — this compiles once Task 5/6/7 land; for now it references `AuthModule`/`UsersModule` which already exist as stubs)

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    PrismaModule,
    CommonModule,
    AuthModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
```

This references `CommonModule`, which does not exist yet — create a minimal placeholder now (Task 6 will flesh it out with CSRF and wire it into `configure()`):

`src/common/common.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';

@Global()
@Module({})
export class CommonModule {}
```

- [ ] **Step 7: Build and verify**

```bash
pnpm run build
```

Expected: compiles with no errors (the stub `AuthModule`/`UsersModule` controllers still exist from the original scaffold at this point).

- [ ] **Step 8: Commit**

```bash
git add src/common src/auth/types src/app.controller.ts src/app.module.ts
git commit -m "feat: add RBAC decorators/guards and wire global guards"
```

---

### Task 5: AuditLogModule

**Files:**
- Create: `src/audit-log/audit-log.service.ts`
- Create: `src/audit-log/audit-log.controller.ts`
- Create: `src/audit-log/audit-log.module.ts`
- Create: `src/audit-log/dto/query-audit-log.dto.ts`
- Modify: `src/app.module.ts` (import `AuditLogModule`)

**Interfaces:**
- Consumes: `PrismaService` (Task 2), `Roles()` decorator (Task 4).
- Produces: `AuditLogService.log(userId: string | null, action: string, entityType: string, entityId: string | null, details?: Prisma.InputJsonValue, ipAddress?: string): Promise<void>` — this exact signature is called by `AuthService` (Task 8/11) and `UsersService` (Task 12). `AuditLogModule` exports `AuditLogService`.

- [ ] **Step 1: Write the query DTO**

`src/audit-log/dto/query-audit-log.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryAuditLogDto {
  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
```

- [ ] **Step 2: Write `AuditLogService`**

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

@Injectable()
export class AuditLogService {
  constructor(private prisma: PrismaService) {}

  async log(
    userId: string | null,
    action: string,
    entityType: string,
    entityId: string | null,
    details?: Prisma.InputJsonValue,
    ipAddress?: string,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: { userId, action, entityType, entityId, details, ipAddress },
    });
  }

  findMany(query: QueryAuditLogDto) {
    const where: Prisma.AuditLogWhereInput = {
      entityType: query.entityType,
      userId: query.userId,
      createdAt: {
        gte: query.dateFrom ? new Date(query.dateFrom) : undefined,
        lte: query.dateTo ? new Date(query.dateTo) : undefined,
      },
    };

    return this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: query.skip ?? 0,
      take: query.take ?? 50,
    });
  }
}
```

- [ ] **Step 3: Write `AuditLogController`**

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditLogService } from './audit-log.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

@Roles('administrator')
@Controller('audit-logs')
export class AuditLogController {
  constructor(private auditLogService: AuditLogService) {}

  @Get()
  findMany(@Query() query: QueryAuditLogDto) {
    return this.auditLogService.findMany(query);
  }
}
```

- [ ] **Step 4: Write `AuditLogModule`**

```typescript
import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';

@Module({
  controllers: [AuditLogController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
```

- [ ] **Step 5: Import it into `AppModule`**

Add `AuditLogModule` to the `imports` array in `src/app.module.ts` (alphabetically alongside the others).

- [ ] **Step 6: Build and verify**

```bash
pnpm run build
```

Expected: compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/audit-log src/app.module.ts
git commit -m "feat: add AuditLogModule with admin-only GET /audit-logs"
```

---

### Task 6: CSRF service + middleware, scoped to /auth/refresh and /auth/logout

**Files:**
- Create: `src/common/csrf/csrf.service.ts`
- Create: `src/common/csrf/csrf.middleware.ts`
- Modify: `src/common/common.module.ts` (register `CsrfService`, export it)
- Modify: `src/app.module.ts` (implement `NestModule.configure()` to apply the middleware)

**Interfaces:**
- Consumes: `ConfigService` (Task 3), `CSRF_SECRET` env var.
- Produces: `CsrfService.generateToken(req, res): string` (consumed by `AuthController`'s `GET /auth/csrf-token` in Task 8), `CsrfService.protect` (an Express middleware function, consumed by `CsrfMiddleware`). `CsrfMiddleware` is applied only to `POST /auth/refresh` and `POST /auth/logout`.

- [ ] **Step 1: Write `CsrfService`**

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { doubleCsrf } from 'csrf-csrf';
import { Request, Response } from 'express';

@Injectable()
export class CsrfService {
  private readonly utils: ReturnType<typeof doubleCsrf>;

  constructor(configService: ConfigService) {
    this.utils = doubleCsrf({
      getSecret: () => configService.get<string>('CSRF_SECRET')!,
      getSessionIdentifier: (req) => req.cookies?.['refreshToken'] ?? '',
      cookieName: 'csrfToken',
      cookieOptions: {
        sameSite: 'lax',
        path: '/auth',
        secure: configService.get<string>('NODE_ENV') === 'production',
        httpOnly: true,
      },
      getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token'],
    });
  }

  generateToken(req: Request, res: Response): string {
    return this.utils.generateCsrfToken(req, res);
  }

  get protect() {
    return this.utils.doubleCsrfProtection;
  }
}
```

- [ ] **Step 2: Write `CsrfMiddleware`**

```typescript
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { CsrfService } from './csrf.service';

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(private csrfService: CsrfService) {}

  use(req: Request, res: Response, next: NextFunction) {
    this.csrfService.protect(req, res, next);
  }
}
```

- [ ] **Step 3: Register both in `CommonModule`**

```typescript
import { Global, Module } from '@nestjs/common';
import { CsrfMiddleware } from './csrf/csrf.middleware';
import { CsrfService } from './csrf/csrf.service';

@Global()
@Module({
  providers: [CsrfService, CsrfMiddleware],
  exports: [CsrfService],
})
export class CommonModule {}
```

- [ ] **Step 4: Apply the middleware in `AppModule`**

Update `src/app.module.ts` to implement `NestModule`:

```typescript
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
// ...existing imports...
import { CsrfMiddleware } from './common/csrf/csrf.middleware';

@Module({ /* ...as in Task 5... */ })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(CsrfMiddleware)
      .forRoutes(
        { path: 'auth/refresh', method: RequestMethod.POST },
        { path: 'auth/logout', method: RequestMethod.POST },
      );
  }
}
```

- [ ] **Step 5: Build and verify**

```bash
pnpm run build
```

Expected: compiles with no errors. (Full runtime verification of the CSRF flow happens in Task 9, once `/auth/refresh` and `/auth/logout` exist.)

- [ ] **Step 6: Commit**

```bash
git add src/common src/app.module.ts
git commit -m "feat: add CSRF double-submit protection scoped to refresh/logout"
```

---

### Task 7: Passport strategies (JWT, Local, Google) and their guards

**Files:**
- Create: `src/auth/strategies/jwt.strategy.ts`
- Create: `src/auth/strategies/local.strategy.ts`
- Create: `src/auth/strategies/google.strategy.ts`
- Create: `src/auth/guards/local-auth.guard.ts`
- Create: `src/auth/guards/google-auth.guard.ts`
- Delete: `src/auth/dto/create-auth.dto.ts`, `src/auth/dto/update-auth.dto.ts`, `src/auth/entities/auth.entity.ts`, `src/auth/auth.controller.spec.ts`, `src/auth/auth.service.spec.ts`

**Interfaces:**
- Consumes: `AccessTokenPayload`, `AuthenticatedUser` (Task 4), `ConfigService`, `AuthService.validateCredentials` (defined in Task 8 — this task's `LocalStrategy` calls it, so build verification happens together with Task 8).
- Produces: passport strategies named `'jwt'`, `'local'`, `'google'`; `LocalAuthGuard`, `GoogleAuthGuard`; exported type `GoogleProfile { googleId: string; email: string; name: string; avatarUrl?: string }` (consumed by `AuthService.loginWithGoogle` in Task 11).

- [ ] **Step 1: Remove the stub scaffold files**

```bash
rm src/auth/dto/create-auth.dto.ts src/auth/dto/update-auth.dto.ts
rm -r src/auth/entities
rm src/auth/auth.controller.spec.ts src/auth/auth.service.spec.ts
```

- [ ] **Step 2: Write `JwtStrategy`**

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AccessTokenPayload, AuthenticatedUser } from '../types/jwt-payload.type';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET')!,
    });
  }

  validate(payload: AccessTokenPayload): AuthenticatedUser {
    return { userId: payload.sub, roles: payload.roles };
  }
}
```

- [ ] **Step 3: Write `LocalStrategy`**

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({ usernameField: 'email' });
  }

  async validate(email: string, password: string) {
    const user = await this.authService.validateCredentials(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return user;
  }
}
```

- [ ] **Step 4: Write `GoogleStrategy`**

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy, VerifyCallback } from 'passport-google-oauth20';

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID')!,
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET')!,
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL')!,
      scope: ['email', 'profile'],
    });
  }

  validate(_accessToken: string, _refreshToken: string, profile: Profile, done: VerifyCallback) {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new Error('Google account has no email'), undefined);
      return;
    }
    const googleProfile: GoogleProfile = {
      googleId: profile.id,
      email,
      name: profile.displayName,
      avatarUrl: profile.photos?.[0]?.value,
    };
    done(null, googleProfile);
  }
}
```

- [ ] **Step 5: Write the two guards**

`src/auth/guards/local-auth.guard.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}
```

`src/auth/guards/google-auth.guard.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
```

- [ ] **Step 6: Build** (expected to still fail at this point — `AuthService.validateCredentials` doesn't exist until Task 8; that's fine, this task's code is exercised by Task 8's build step)

- [ ] **Step 7: Commit**

```bash
git add src/auth/strategies src/auth/guards
git add -u src/auth/dto src/auth/entities src/auth/auth.controller.spec.ts src/auth/auth.service.spec.ts
git commit -m "feat: add jwt/local/google passport strategies, remove stub auth scaffold"
```

---

### Task 8: Auth service core — signup, login, token issuance, refresh, logout

**Files:**
- Create: `src/auth/dto/signup.dto.ts`
- Modify: `src/auth/auth.service.ts` (full rewrite)
- Modify: `package.json` (`@nestjs/jwt` already installed; no new deps)

**Interfaces:**
- Consumes: `PrismaService` (Task 2), `AuditLogService.log(...)` (Task 5), `AppRole`/`User` from `@prisma/client`.
- Produces:
  - `AuthService.signup(dto: SignupDto, res: Response, ip?: string): Promise<{ accessToken: string; user: object; needsRoleSelection: boolean }>`
  - `AuthService.validateCredentials(email: string, password: string): Promise<User | null>` (consumed by `LocalStrategy`, Task 7)
  - `AuthService.login(user: User, res: Response): Promise<{ accessToken: string; user: object; needsRoleSelection: boolean }>`
  - `AuthService.refresh(rawRefreshToken: string | undefined, res: Response): Promise<{ accessToken: string; user: object; needsRoleSelection: boolean }>`
  - `AuthService.logout(rawRefreshToken: string | undefined, res: Response): Promise<void>`
  - (Google/complete-profile methods land in Task 11, same file.)

- [ ] **Step 1: Write `SignupDto`**

```typescript
import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

export class SignupDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  company?: string;

  @IsOptional()
  @IsString()
  certificationDetails?: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AppRole, { each: true })
  roles: AppRole[];
}
```

- [ ] **Step 2: Rewrite `src/auth/auth.service.ts`**

```typescript
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppRole, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { Response } from 'express';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { SignupDto } from './dto/signup.dto';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_TTL = '15m';

export interface AuthResult {
  accessToken: string;
  user: Record<string, unknown>;
  needsRoleSelection: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private auditLogService: AuditLogService,
  ) {}

  async signup(dto: SignupDto, res: Response, ip?: string): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name,
        phone: dto.phone,
        company: dto.company,
        certificationDetails: dto.certificationDetails,
        roles: { create: dto.roles.map((role) => ({ role })) },
      },
    });

    await this.auditLogService.log(
      user.id,
      'user.roles_assigned',
      'User',
      user.id,
      { roles: dto.roles },
      ip,
    );

    return this.issueTokens(user.id, res);
  }

  async validateCredentials(email: string, password: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      return null;
    }
    const matches = await bcrypt.compare(password, user.passwordHash);
    return matches ? user : null;
  }

  async login(user: User, res: Response): Promise<AuthResult> {
    return this.issueTokens(user.id, res);
  }

  async refresh(rawRefreshToken: string | undefined, res: Response): Promise<AuthResult> {
    if (!rawRefreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    let payload: { sub: string };
    try {
      payload = await this.jwtService.verifyAsync(rawRefreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { userId: payload.sub, tokenHash },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      // Reuse of an already-rotated/revoked token: treat as compromise, kill the whole session.
      await this.prisma.refreshToken.updateMany({
        where: { userId: payload.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(payload.sub, res);
  }

  async logout(rawRefreshToken: string | undefined, res: Response): Promise<void> {
    if (rawRefreshToken) {
      const tokenHash = this.hashToken(rawRefreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
  }

  private async getRoles(userId: string): Promise<AppRole[]> {
    const roles = await this.prisma.userRole.findMany({ where: { userId } });
    return roles.map((r) => r.role);
  }

  private async issueTokens(userId: string, res: Response): Promise<AuthResult> {
    const [user, roles] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.getRoles(userId),
    ]);

    const accessToken = await this.jwtService.signAsync(
      { sub: userId, roles },
      {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: ACCESS_TOKEN_TTL,
      },
    );

    const refreshToken = await this.jwtService.signAsync(
      { sub: userId, jti: randomUUID() },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      },
    );

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: this.configService.get<string>('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: '/auth',
      maxAge: REFRESH_TOKEN_TTL_MS,
    });

    const { passwordHash: _passwordHash, ...safeUser } = user;

    return {
      accessToken,
      user: { ...safeUser, roles },
      needsRoleSelection: roles.length === 0,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
```

- [ ] **Step 3: Build**

```bash
pnpm run build
```

Expected: compiles with no errors (this also validates Task 7's `LocalStrategy`, which calls `validateCredentials`).

- [ ] **Step 4: Commit**

```bash
git add src/auth/auth.service.ts src/auth/dto/signup.dto.ts
git commit -m "feat: implement AuthService signup/login/refresh/logout token issuance"
```

---

### Task 9: AuthModule + AuthController — signup, login, refresh, logout, csrf-token

**Files:**
- Modify: `src/auth/auth.controller.ts` (full rewrite)
- Modify: `src/auth/auth.module.ts` (full rewrite)

**Interfaces:**
- Consumes: `AuthService` (Task 8), `CsrfService` (Task 6), `Public()` (Task 4), `LocalAuthGuard` (Task 7).
- Produces: `POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/csrf-token`.

- [ ] **Step 1: Rewrite `src/auth/auth.controller.ts`**

```typescript
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UseGuards,
  Get,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { User } from '@prisma/client';
import { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CsrfService } from '../common/csrf/csrf.service';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';

@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private csrfService: CsrfService,
  ) {}

  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response, @Ip() ip: string) {
    return this.authService.signup(dto, res, ip);
  }

  @Public()
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.login(req.user as User, res);
  }

  @Public()
  @Get('csrf-token')
  csrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrfToken: this.csrfService.generateToken(req, res) };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.refresh(req.cookies?.['refreshToken'], res);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.cookies?.['refreshToken'], res);
    return { success: true };
  }
}
```

- [ ] **Step 2: Rewrite `src/auth/auth.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';

@Module({
  imports: [PassportModule, JwtModule.register({}), AuditLogModule],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, LocalStrategy],
})
export class AuthModule {}
```

(`GoogleStrategy` is added to `providers` in Task 11, once the Google login flow is implemented — omitting it here keeps this task's build green without requiring `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to be set yet.)

- [ ] **Step 3: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

- [ ] **Step 4: Manually verify signup**

```bash
curl -i -X POST http://localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"contractor1@example.com","password":"password123","name":"Contractor One","roles":["contractor"]}'
```

Expected: `201 Created` (or `200`, depending on default Nest status for POST — verify and note actual code), JSON body with `accessToken`, `user.roles` = `["contractor"]`, `needsRoleSelection: false`, and a `Set-Cookie: refreshToken=...` header.

- [ ] **Step 5: Manually verify login**

```bash
curl -i -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"contractor1@example.com","password":"password123"}'
```

Expected: `200 OK` with a fresh `accessToken` and `Set-Cookie: refreshToken=...`.

- [ ] **Step 6: Manually verify refresh + CSRF rejection/acceptance**

```bash
# Save the refreshToken cookie from Step 5's response, e.g. into $REFRESH_COOKIE

# 1. Get a CSRF token (also sets the csrfToken cookie)
curl -i -c cookies.txt -b "refreshToken=$REFRESH_COOKIE" http://localhost:3000/auth/csrf-token

# 2. Without the x-csrf-token header, refresh must fail:
curl -i -b cookies.txt -b "refreshToken=$REFRESH_COOKIE" -X POST http://localhost:3000/auth/refresh

# Expected: 403 Forbidden (csrf validation failed)

# 3. With the header (paste the csrfToken value returned in step 1's JSON body):
curl -i -b cookies.txt -b "refreshToken=$REFRESH_COOKIE" -H "x-csrf-token: <token from step 1>" -X POST http://localhost:3000/auth/refresh
```

Expected: step 3 returns `200 OK` with a new `accessToken` and a rotated `Set-Cookie: refreshToken=...`. Re-running the exact same request with the now-stale `$REFRESH_COOKIE` should return `401 Unauthorized`.

- [ ] **Step 7: Manually verify logout** (same CSRF-token dance as refresh) and then confirm `POST /auth/refresh` with the logged-out cookie returns `401`. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/auth/auth.controller.ts src/auth/auth.module.ts
git commit -m "feat: wire up auth signup/login/refresh/logout/csrf-token endpoints"
```

---

### Task 10: Google OAuth + complete-profile

**Files:**
- Create: `src/auth/dto/complete-profile.dto.ts`
- Modify: `src/auth/auth.service.ts` (add `loginWithGoogle`, `completeProfile`)
- Modify: `src/auth/auth.controller.ts` (add Google routes + complete-profile route)
- Modify: `src/auth/auth.module.ts` (register `GoogleStrategy`)

**Interfaces:**
- Consumes: `GoogleProfile` (Task 7), `AllowNoRole()` (Task 4), `CurrentUser()` (Task 4).
- Produces: `AuthService.loginWithGoogle(profile: GoogleProfile, res: Response): Promise<AuthResult>`, `AuthService.completeProfile(userId: string, dto: CompleteProfileDto, res: Response, ip?: string): Promise<AuthResult>`, routes `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/complete-profile`.

- [ ] **Step 1: Write `CompleteProfileDto`**

```typescript
import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum } from 'class-validator';

export class CompleteProfileDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AppRole, { each: true })
  roles: AppRole[];
}
```

- [ ] **Step 2: Add `loginWithGoogle` and `completeProfile` to `AuthService`**

Add these imports to the top of `src/auth/auth.service.ts`:

```typescript
import { ForbiddenException } from '@nestjs/common'; // merge into the existing @nestjs/common import
import { GoogleProfile } from './strategies/google.strategy';
import { CompleteProfileDto } from './dto/complete-profile.dto';
```

Add these two methods to the `AuthService` class (alongside `login`):

```typescript
  async loginWithGoogle(profile: GoogleProfile, res: Response): Promise<AuthResult> {
    let user = await this.prisma.user.findUnique({ where: { googleId: profile.googleId } });

    if (!user) {
      const existingByEmail = await this.prisma.user.findUnique({ where: { email: profile.email } });
      user = existingByEmail
        ? await this.prisma.user.update({
            where: { id: existingByEmail.id },
            data: { googleId: profile.googleId },
          })
        : await this.prisma.user.create({
            data: {
              email: profile.email,
              googleId: profile.googleId,
              name: profile.name,
              avatarUrl: profile.avatarUrl,
            },
          });
    }

    return this.issueTokens(user.id, res);
  }

  async completeProfile(
    userId: string,
    dto: CompleteProfileDto,
    res: Response,
    ip?: string,
  ): Promise<AuthResult> {
    const existingRoles = await this.getRoles(userId);
    if (existingRoles.length > 0) {
      throw new ForbiddenException('Profile roles already set');
    }

    await this.prisma.userRole.createMany({
      data: dto.roles.map((role) => ({ userId, role })),
      skipDuplicates: true,
    });

    await this.auditLogService.log(userId, 'user.roles_assigned', 'User', userId, { roles: dto.roles }, ip);

    return this.issueTokens(userId, res);
  }
```

- [ ] **Step 3: Add Google + complete-profile routes to `AuthController`**

Add these imports:

```typescript
import { AllowNoRole } from '../common/decorators/allow-no-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from './types/jwt-payload.type';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { GoogleAuthGuard } from './guards/google-auth.guard';
```

Add these routes to the `AuthController` class:

```typescript
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Guard redirects to Google's consent screen; no body to return.
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  googleCallback(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.loginWithGoogle(req.user as GoogleProfile, res);
  }

  @AllowNoRole()
  @Post('complete-profile')
  completeProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CompleteProfileDto,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    return this.authService.completeProfile(user.userId, dto, res, ip);
  }
```

Also import `GoogleProfile` type from `./strategies/google.strategy'`.

- [ ] **Step 4: Register `GoogleStrategy` in `AuthModule`**

```typescript
import { GoogleStrategy } from './strategies/google.strategy';
// ...
providers: [AuthService, JwtStrategy, LocalStrategy, GoogleStrategy],
```

- [ ] **Step 5: Set real Google OAuth credentials in `.env`** (create a project in Google Cloud Console if you don't have test credentials; set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback`)

- [ ] **Step 6: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

- [ ] **Step 7: Manually verify the Google flow** — open `http://localhost:3000/auth/google` in a browser, complete the Google consent screen, and confirm the callback response JSON has `needsRoleSelection: true` and an empty `roles` array. Then, using the returned `accessToken`:

```bash
curl -i -X POST http://localhost:3000/auth/complete-profile \
  -H "Authorization: Bearer <accessToken>" \
  -H 'Content-Type: application/json' \
  -d '{"roles":["engineer"]}'
```

Expected: `201`/`200` with `needsRoleSelection: false` and `user.roles: ["engineer"]`. Calling the same endpoint again with the same token should now return `403 Forbidden` (roles already set). Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/auth
git commit -m "feat: add google oauth login and complete-profile role selection"
```

---

### Task 11: Users module — self profile + admin management

**Files:**
- Create: `src/users/dto/update-profile.dto.ts`
- Create: `src/users/dto/update-status.dto.ts`
- Create: `src/users/dto/update-roles.dto.ts`
- Create: `src/users/users.service.ts`
- Create: `src/users/users.controller.ts`
- Modify: `src/users/users.module.ts`

**Interfaces:**
- Consumes: `PrismaService` (Task 2), `AuditLogService` (Task 5), `Roles()`/`CurrentUser()` (Task 4).
- Produces: `GET /users/me`, `PATCH /users/me`, `GET /users` (administrator), `PATCH /users/:id/status` (administrator), `PATCH /users/:id/roles` (administrator).

- [ ] **Step 1: Write the three DTOs**

`src/users/dto/update-profile.dto.ts`:

```typescript
import { IsOptional, IsString } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  company?: string;

  @IsOptional()
  @IsString()
  certificationDetails?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;
}
```

`src/users/dto/update-status.dto.ts`:

```typescript
import { IsIn } from 'class-validator';

export class UpdateStatusDto {
  @IsIn(['active', 'inactive'])
  status: 'active' | 'inactive';
}
```

`src/users/dto/update-roles.dto.ts`:

```typescript
import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum } from 'class-validator';

export class UpdateRolesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AppRole, { each: true })
  roles: AppRole[];
}
```

- [ ] **Step 2: Write `UsersService`**

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { AppRole, User } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

type UserWithRoles = User & { roles: { role: AppRole }[] };

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
  ) {}

  async findSelf(userId: string) {
    return this.toSafeUser(await this.findUserOrThrow(userId));
  }

  async updateSelf(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
      include: { roles: true },
    });
    return this.toSafeUser(user);
  }

  async findAll() {
    const users = await this.prisma.user.findMany({ include: { roles: true } });
    return users.map((user) => this.toSafeUser(user));
  }

  async updateStatus(targetUserId: string, dto: UpdateStatusDto, adminUserId: string, ip?: string) {
    await this.findUserOrThrow(targetUserId);

    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: dto.status },
      include: { roles: true },
    });

    await this.auditLogService.log(
      adminUserId,
      'user.status_updated',
      'User',
      targetUserId,
      { status: dto.status },
      ip,
    );

    return this.toSafeUser(user);
  }

  async updateRoles(targetUserId: string, dto: UpdateRolesDto, adminUserId: string, ip?: string) {
    await this.findUserOrThrow(targetUserId);

    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: targetUserId } }),
      this.prisma.userRole.createMany({
        data: dto.roles.map((role) => ({ userId: targetUserId, role })),
      }),
    ]);

    await this.auditLogService.log(
      adminUserId,
      'user.roles_updated',
      'User',
      targetUserId,
      { roles: dto.roles },
      ip,
    );

    return this.toSafeUser(await this.findUserOrThrow(targetUserId));
  }

  private async findUserOrThrow(userId: string): Promise<UserWithRoles> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private toSafeUser(user: UserWithRoles) {
    const { passwordHash: _passwordHash, roles, ...safe } = user;
    return { ...safe, roles: roles.map((r) => r.role) };
  }
}
```

- [ ] **Step 3: Write `UsersController`**

```typescript
import { Body, Controller, Get, Ip, Param, Patch } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  getSelf(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findSelf(user.userId);
  }

  @Patch('me')
  updateSelf(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateSelf(user.userId, dto);
  }

  @Roles('administrator')
  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Roles('administrator')
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.usersService.updateStatus(id, dto, admin.userId, ip);
  }

  @Roles('administrator')
  @Patch(':id/roles')
  updateRoles(
    @Param('id') id: string,
    @Body() dto: UpdateRolesDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.usersService.updateRoles(id, dto, admin.userId, ip);
  }
}
```

- [ ] **Step 4: Rewrite `src/users/users.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuditLogModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 5: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

- [ ] **Step 6: Manually verify the full RBAC stack**

```bash
# Using the accessToken from a contractor signup (Task 9, Step 4):
curl -i http://localhost:3000/users/me -H "Authorization: Bearer <contractor accessToken>"
```

Expected: `200 OK` with the contractor's own profile, no `passwordHash` field.

```bash
# Contractor hitting an admin-only route:
curl -i http://localhost:3000/users -H "Authorization: Bearer <contractor accessToken>"
```

Expected: `403 Forbidden` (`{"statusCode":403,...}` — confirms `HttpExceptionFilter` shape).

```bash
# No token at all:
curl -i http://localhost:3000/users/me
```

Expected: `401 Unauthorized`.

Now sign up an administrator and confirm they *can* list users and update another user's status/roles:

```bash
curl -s -X POST http://localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin1@example.com","password":"password123","name":"Admin One","roles":["administrator"]}'

curl -i http://localhost:3000/users -H "Authorization: Bearer <admin accessToken>"
```

Expected: `200 OK` with both users listed. Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/users
git commit -m "feat: implement users self-service and admin management endpoints"
```

---

## Self-Review Notes

- Spec coverage: Prisma schema (§3) — Task 1. Global middleware/pipes/filter (§1) — Task 3. Auth & RBAC (§2) — Tasks 4, 7, 8, 9, 10. Audit logging service + admin endpoint (§7, and the `Users/roles` row of §4) — Task 5, called from Tasks 8/10/11. Users authorization row of §4 — Task 11. Infra/config (§8) — Task 1, 3. Section §5 (Media), §6 (Reports), and the remaining rows of §4 (Sites, InspectionRequests, Inspections, Media, Reports, InspectionTemplates) are out of scope for this plan — they're separate subsystems per the incremental approach agreed with the user, to be planned next.
- No placeholders: every step has literal file contents; no "add validation" or "TBD" steps remain.
- Type consistency check: `AuthResult` (Task 8) is the return type used consistently by `signup`/`login`/`refresh`/`loginWithGoogle`/`completeProfile`. `AuthenticatedUser`/`AccessTokenPayload` (Task 4) are the only shapes referenced by `CurrentUser()`, `JwtStrategy`, `RolesGuard`. `AuditLogService.log(...)`'s 6-argument signature (Task 5) matches every call site in Tasks 8, 10, 11.
