# Sites + InspectionRequests + Swagger Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `Sites` and `InspectionRequests` modules (CRUD + role/ownership authorization + the pending→accepted/rejected transition), and add Swagger/OpenAPI documentation covering the entire API, including the already-shipped `Auth`/`Users`/`AuditLog` modules.

**Architecture:** Two new modules following the exact same shape as the existing `Users`/`AuditLog` modules (DTO + Service + Controller + Module, wired into `AppModule`). Ownership/role authorization is enforced in the service layer (not just `@Roles()`), matching the pattern already used by `UsersService`. Swagger is configured once, globally, in `main.ts`, and every controller/DTO across the whole app gets `@Api*` decorators layered onto its existing `class-validator` decorators.

**Tech Stack:** NestJS 11, Prisma (no schema migration needed this pass), `@nestjs/swagger`, `class-validator`/`class-transformer` (already installed). Package manager is **pnpm**.

## Global Constraints

- No automated tests in this pass (matches the rest of the project — design spec §9 and the foundation plan). Every task substitutes a manual verification step (build + `pnpm run start:dev` + `curl`) for the usual test-first cycle.
- One module per domain: `Sites`, `InspectionRequests`, alongside the existing `Auth`, `Users`, `AuditLog`, `Prisma`, `Common` modules.
- Global `JwtAuthGuard` + `RolesGuard` (already registered as `APP_GUARD`s) guard every route by default. `@Roles('contractor', 'administrator')` etc. narrows by role; ownership checks (owning contractor, assigned engineer) happen inside the service method, not the guard — same pattern as `UsersService.updateStatus`.
- No Prisma schema migration in this plan. `Site.status` stays a plain `String` column; the wider `active | inactive | paused | completed` set is enforced only at the DTO validation layer (`@IsIn(SITE_STATUSES)`), the same way `User.status` is validated today.
- Every mutation (`create`/`update`/`accept`/`reject`/`delete`) calls `AuditLogService.log(userId, action, entityType, entityId, details?, ipAddress?)` — exact signature already defined in `src/audit-log/audit-log.service.ts`.
- Swagger/OpenAPI is served at `GET /docs` (HTML) and `GET /docs-json` (raw spec), configured via `@nestjs/swagger`'s `SwaggerModule.setup()`, which registers its routes directly on the underlying HTTP adapter — outside Nest's guard pipeline, so no `@Public()` decorator is needed for it to be reachable without a token.
- Package manager is `pnpm`, not `npm`/`yarn`.

---

## File Structure

```
package.json                                    (modify: add @nestjs/swagger)
src/
  main.ts                                        (modify: add Swagger bootstrap)
  app.module.ts                                  (modify: import SitesModule, InspectionRequestsModule)
  auth/
    auth.controller.ts                           (modify: add Swagger decorators)
    dto/signup.dto.ts                            (modify: add Swagger decorators)
    dto/complete-profile.dto.ts                  (modify: add Swagger decorators)
  users/
    users.controller.ts                          (modify: add Swagger decorators)
    dto/update-profile.dto.ts                    (modify: add Swagger decorators)
    dto/update-status.dto.ts                     (modify: add Swagger decorators)
    dto/update-roles.dto.ts                      (modify: add Swagger decorators)
  audit-log/
    audit-log.controller.ts                      (modify: add Swagger decorators)
    dto/query-audit-log.dto.ts                   (modify: add Swagger decorators)
  sites/
    site-status.ts                               (create: SITE_STATUSES constant)
    sites.module.ts                              (create)
    sites.controller.ts                          (create)
    sites.service.ts                             (create)
    dto/create-site.dto.ts                       (create)
    dto/update-site.dto.ts                       (create)
  inspection-requests/
    inspection-requests.module.ts                (create)
    inspection-requests.controller.ts             (create)
    inspection-requests.service.ts                (create)
    dto/create-inspection-request.dto.ts          (create)
    dto/update-inspection-request.dto.ts          (create)
    dto/accept-inspection-request.dto.ts          (create)
```

---

### Task 1: Install and configure Swagger globally

**Files:**
- Modify: `package.json` (add `@nestjs/swagger`)
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /docs` (Swagger UI), `GET /docs-json` (raw OpenAPI spec). No code in later tasks calls anything from this task directly — later tasks only add `@Api*` decorators, which `SwaggerModule.createDocument()` picks up automatically at bootstrap.

- [x] **Step 1: Install the package**

```bash
pnpm add @nestjs/swagger
```

- [x] **Step 2: Rewrite `src/main.ts`**

```typescript
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Ujenzi Digital API')
    .setDescription(
      'Errors are normalized to { statusCode, message, error } by a global exception filter. ' +
        'Most routes require a Bearer access token; /auth/refresh and /auth/logout additionally ' +
        'require an x-csrf-token header (see GET /auth/csrf-token).',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
}
bootstrap();
```

- [x] **Step 3: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

- [x] **Step 4: Verify the docs routes are reachable without a token**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/docs
curl -s http://localhost:3000/docs-json | grep -o '"openapi":"[^"]*"'
```

Expected: first command prints `200`; second prints `"openapi":"3.0.0"` (or similar). Stop the dev server.

- [x] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/main.ts
git commit -m "feat: add Swagger/OpenAPI docs at /docs"
```

---

### Task 2: Retroactively decorate Auth, Users, AuditLog with Swagger

**Files:**
- Modify: `src/auth/auth.controller.ts`
- Modify: `src/auth/dto/signup.dto.ts`
- Modify: `src/auth/dto/complete-profile.dto.ts`
- Modify: `src/users/users.controller.ts`
- Modify: `src/users/dto/update-profile.dto.ts`
- Modify: `src/users/dto/update-status.dto.ts`
- Modify: `src/users/dto/update-roles.dto.ts`
- Modify: `src/audit-log/audit-log.controller.ts`
- Modify: `src/audit-log/dto/query-audit-log.dto.ts`

**Interfaces:**
- Consumes: `@nestjs/swagger` (Task 1).
- Produces: nothing new consumed by later tasks — this task is documentation-only, no behavior changes.

- [x] **Step 1: Rewrite `src/auth/auth.controller.ts`**

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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { AllowNoRole } from '../common/decorators/allow-no-role.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CsrfService } from '../common/csrf/csrf.service';
import { AuthService } from './auth.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { SignupDto } from './dto/signup.dto';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import type { GoogleProfile } from './strategies/google.strategy';
import type { AuthenticatedUser } from './types/jwt-payload.type';

@ApiTags('Auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private csrfService: CsrfService,
  ) {}

  @ApiOperation({ summary: 'Sign up with email/password; roles are active immediately' })
  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto, @Res({ passthrough: true }) res: Response, @Ip() ip: string) {
    return this.authService.signup(dto, res, ip);
  }

  @ApiOperation({ summary: 'Log in with email/password' })
  @Public()
  @UseGuards(LocalAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.login(req.user as User, res);
  }

  @ApiOperation({ summary: 'Get a CSRF token for the refresh/logout double-submit cookie' })
  @Public()
  @Get('csrf-token')
  csrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { csrfToken: this.csrfService.generateToken(req, res) };
  }

  @ApiOperation({ summary: 'Rotate the refresh token and issue a fresh access token (requires x-csrf-token)' })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.refresh(req.cookies?.['refreshToken'], res);
  }

  @ApiOperation({ summary: 'Revoke the current refresh token (requires x-csrf-token)' })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.cookies?.['refreshToken'], res);
    return { success: true };
  }

  @ApiOperation({ summary: "Redirect to Google's OAuth consent screen" })
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Guard redirects to Google's consent screen; no body to return.
  }

  @ApiOperation({ summary: 'Google OAuth callback; returns needsRoleSelection: true for first-time logins' })
  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  googleCallback(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.loginWithGoogle(req.user as GoogleProfile, res);
  }

  @ApiOperation({ summary: 'Set initial role(s) for a zero-role Google account' })
  @ApiBearerAuth()
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
}
```

- [x] **Step 2: Rewrite `src/auth/dto/signup.dto.ts`**

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export const SELF_SIGNUP_ROLES: AppRole[] = [
  AppRole.engineer,
  AppRole.contractor,
  AppRole.site_representative,
];

export class SignupDto {
  @ApiProperty({ example: 'contractor1@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 8 })
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'Contractor One' })
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  company?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  certificationDetails?: string;

  @ApiProperty({ enum: SELF_SIGNUP_ROLES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SELF_SIGNUP_ROLES, { each: true })
  roles: AppRole[];
}
```

- [x] **Step 3: Rewrite `src/auth/dto/complete-profile.dto.ts`**

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsIn } from 'class-validator';
import { SELF_SIGNUP_ROLES } from './signup.dto';

export class CompleteProfileDto {
  @ApiProperty({ enum: SELF_SIGNUP_ROLES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(SELF_SIGNUP_ROLES, { each: true })
  roles: AppRole[];
}
```

- [x] **Step 4: Rewrite `src/users/users.controller.ts`**

```typescript
import { Body, Controller, Get, Ip, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @ApiOperation({ summary: "Get the caller's own profile" })
  @Get('me')
  getSelf(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findSelf(user.userId);
  }

  @ApiOperation({ summary: "Update the caller's own profile fields" })
  @Patch('me')
  updateSelf(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateSelf(user.userId, dto);
  }

  @ApiOperation({ summary: 'List all users (administrator only)' })
  @Roles('administrator')
  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @ApiOperation({ summary: "Update a user's active/inactive status (administrator only)" })
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

  @ApiOperation({ summary: "Replace a user's roles (administrator only)" })
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

- [x] **Step 5: Rewrite the three Users DTOs**

`src/users/dto/update-profile.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  company?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  certificationDetails?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;
}
```

`src/users/dto/update-status.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateStatusDto {
  @ApiProperty({ enum: ['active', 'inactive'] })
  @IsIn(['active', 'inactive'])
  status: 'active' | 'inactive';
}
```

`src/users/dto/update-roles.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { AppRole } from '@prisma/client';
import { ArrayMinSize, IsArray, IsEnum } from 'class-validator';

export class UpdateRolesDto {
  @ApiProperty({ enum: AppRole, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(AppRole, { each: true })
  roles: AppRole[];
}
```

- [x] **Step 6: Rewrite `src/audit-log/audit-log.controller.ts`**

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditLogService } from './audit-log.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

@ApiTags('AuditLog')
@ApiBearerAuth()
@Roles('administrator')
@Controller('audit-logs')
export class AuditLogController {
  constructor(private auditLogService: AuditLogService) {}

  @ApiOperation({ summary: 'List audit log entries, filterable by entity/user/date (administrator only)' })
  @Get()
  findMany(@Query() query: QueryAuditLogDto) {
    return this.auditLogService.findMany(query);
  }
}
```

- [x] **Step 7: Rewrite `src/audit-log/dto/query-audit-log.dto.ts`**

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryAuditLogDto {
  @ApiPropertyOptional({ example: 'Site' })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
```

- [x] **Step 8: Build and verify**

```bash
pnpm run build
pnpm run start:dev
```

```bash
curl -s http://localhost:3000/docs-json | grep -o '"/auth[^"]*"' | sort -u
curl -s http://localhost:3000/docs-json | grep -o '"/users[^"]*"' | sort -u
curl -s http://localhost:3000/docs-json | grep -o '"/audit-logs[^"]*"' | sort -u
```

Expected: each command lists the routes for that controller (e.g. `/auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/csrf-token`, `/auth/google`, `/auth/google/callback`, `/auth/complete-profile` for the first). Stop the dev server.

- [x] **Step 9: Commit**

```bash
git add src/auth/auth.controller.ts src/auth/dto/signup.dto.ts src/auth/dto/complete-profile.dto.ts src/users/users.controller.ts src/users/dto src/audit-log/audit-log.controller.ts src/audit-log/dto/query-audit-log.dto.ts
git commit -m "docs: add Swagger decorators to Auth/Users/AuditLog"
```

---

### Task 3: Sites module

**Files:**
- Create: `src/sites/site-status.ts`
- Create: `src/sites/dto/create-site.dto.ts`
- Create: `src/sites/dto/update-site.dto.ts`
- Create: `src/sites/sites.service.ts`
- Create: `src/sites/sites.controller.ts`
- Create: `src/sites/sites.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService` (existing), `AuditLogService.log(...)` (existing), `AuthenticatedUser` (existing), `@Roles()`/`@CurrentUser()` (existing).
- Produces: `GET /sites`, `GET /sites/:id`, `POST /sites`, `PATCH /sites/:id`, `DELETE /sites/:id`. `SitesService.isWithinGeofence(lat: number, lon: number, site: Site): boolean` — exported for the future Inspections module to call; not called anywhere in this task. `SitesModule` exports `SitesService`.

- [x] **Step 1: Write the site status constant**

`src/sites/site-status.ts`:

```typescript
export const SITE_STATUSES = ['active', 'inactive', 'paused', 'completed'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];
```

- [x] **Step 2: Write `CreateSiteDto`**

`src/sites/dto/create-site.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateSiteDto {
  @ApiProperty({ example: 'Riverside Towers' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description: 'Administrator only — the contractor to create this site for. Ignored/forbidden for contractor callers, who always create for themselves.',
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

  @ApiPropertyOptional({ example: 100, default: 100, description: 'Meters. Defaults to 100 in the database if omitted.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  geofenceRadius?: number;

  @ApiProperty({ example: '123 River Road, Nairobi' })
  @IsString()
  address: string;

  @ApiPropertyOptional({ example: 'Foundation' })
  @IsOptional()
  @IsString()
  constructionPhase?: string;
}
```

- [x] **Step 3: Write `UpdateSiteDto`**

`src/sites/dto/update-site.dto.ts`:

```typescript
import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CreateSiteDto } from './create-site.dto';
import { SITE_STATUSES } from '../site-status';

export class UpdateSiteDto extends PartialType(OmitType(CreateSiteDto, ['contractorId'] as const)) {
  @ApiPropertyOptional({ enum: SITE_STATUSES })
  @IsOptional()
  @IsIn(SITE_STATUSES)
  status?: string;
}
```

- [x] **Step 4: Write `SitesService`**

`src/sites/sites.service.ts`:

```typescript
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

const CONTRACTOR_SELECT = { id: true, name: true, company: true } as const;
const EARTH_RADIUS_METERS = 6_371_000;

@Injectable()
export class SitesService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
  ) {}

  findAll() {
    return this.prisma.site.findMany({
      include: { contractor: { select: CONTRACTOR_SELECT } },
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.findSiteOrThrow(id);
  }

  async create(dto: CreateSiteDto, user: AuthenticatedUser, ip?: string) {
    const contractorId = this.resolveContractorId(dto.contractorId, user);

    const site = await this.prisma.site.create({
      data: {
        name: dto.name,
        contractorId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        geofenceRadius: dto.geofenceRadius,
        address: dto.address,
        constructionPhase: dto.constructionPhase,
      },
      include: { contractor: { select: CONTRACTOR_SELECT } },
    });

    await this.auditLogService.log(user.userId, 'site.created', 'Site', site.id, { contractorId }, ip);

    return site;
  }

  async update(id: string, dto: UpdateSiteDto, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    this.assertOwnerOrAdmin(site, user);

    const updated = await this.prisma.site.update({
      where: { id },
      data: dto,
      include: { contractor: { select: CONTRACTOR_SELECT } },
    });

    await this.auditLogService.log(user.userId, 'site.updated', 'Site', id, { ...dto }, ip);

    return updated;
  }

  async remove(id: string, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    this.assertOwnerOrAdmin(site, user);

    await this.prisma.site.delete({ where: { id } });

    await this.auditLogService.log(user.userId, 'site.deleted', 'Site', id, undefined, ip);
  }

  isWithinGeofence(lat: number, lon: number, site: Site): boolean {
    const radiusMeters = site.geofenceRadius ?? 100;
    const distanceMeters = this.haversineDistanceMeters(lat, lon, Number(site.latitude), Number(site.longitude));
    return distanceMeters <= radiusMeters;
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
      include: { contractor: { select: CONTRACTOR_SELECT } },
    });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return site;
  }
}
```

- [x] **Step 5: Write `SitesController`**

`src/sites/sites.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { SitesService } from './sites.service';

@ApiTags('Sites')
@ApiBearerAuth()
@Controller('sites')
export class SitesController {
  constructor(private sitesService: SitesService) {}

  @ApiOperation({ summary: 'List all sites' })
  @Get()
  findAll() {
    return this.sitesService.findAll();
  }

  @ApiOperation({ summary: 'Get a site by id' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sitesService.findOne(id);
  }

  @ApiOperation({ summary: 'Create a site (contractor for self, or administrator for any contractor)' })
  @Roles('contractor', 'administrator')
  @Post()
  create(@Body() dto: CreateSiteDto, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.sitesService.create(dto, user, ip);
  }

  @ApiOperation({ summary: 'Update a site (owning contractor or administrator)' })
  @Roles('contractor', 'administrator')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSiteDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.sitesService.update(id, dto, user, ip);
  }

  @ApiOperation({ summary: 'Delete a site (owning contractor or administrator)' })
  @Roles('contractor', 'administrator')
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.sitesService.remove(id, user, ip);
  }
}
```

- [x] **Step 6: Write `SitesModule`**

`src/sites/sites.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

@Module({
  imports: [AuditLogModule],
  controllers: [SitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
```

- [x] **Step 7: Wire `SitesModule` into `AppModule`**

Modify `src/app.module.ts` — add the import and add `SitesModule` to the `imports` array (alphabetically, after `PrismaModule` and before `UsersModule`):

```typescript
import { SitesModule } from './sites/sites.module';
// ...
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    PrismaModule,
    CommonModule,
    AuditLogModule,
    AuthModule,
    SitesModule,
    UsersModule,
  ],
  // ...controllers/providers unchanged
})
```

- [x] **Step 8: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

- [x] **Step 9: Manually verify the full Sites CRUD + authorization**

```bash
# Sign up a contractor and an administrator (or reuse tokens from a previous session)
curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"sites-contractor@example.com","password":"password123","name":"Sites Contractor","roles":["contractor"]}'
# Copy the accessToken from the response into $CONTRACTOR_TOKEN, and note the user.id into $CONTRACTOR_ID

curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"sites-admin@example.com","password":"password123","name":"Sites Admin","roles":["administrator"]}'
# Copy the accessToken into $ADMIN_TOKEN
```

```bash
# Contractor creates a site for themselves
curl -i -X POST http://localhost:3000/sites -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Riverside Towers","latitude":-1.2921,"longitude":36.8219,"address":"123 River Road","geofenceRadius":150}'
```

Expected: `201 Created`, response includes `status: "active"`, `geofenceRadius: 150`, nested `contractor: { name: "Sites Contractor", ... }`. Copy the site `id` into `$SITE_ID`.

```bash
# Any authenticated user can list/read
curl -i http://localhost:3000/sites -H "Authorization: Bearer $CONTRACTOR_TOKEN"
curl -i http://localhost:3000/sites/$SITE_ID -H "Authorization: Bearer $CONTRACTOR_TOKEN"

# Contractor updates their own site (e.g. pauses it — tests the widened status set)
curl -i -X PATCH http://localhost:3000/sites/$SITE_ID -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"paused"}'
```

Expected: `200 OK`, `status: "paused"`.

```bash
# A different contractor cannot update or delete it
curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"other-contractor@example.com","password":"password123","name":"Other Contractor","roles":["contractor"]}'
# Copy accessToken into $OTHER_TOKEN

curl -i -X PATCH http://localhost:3000/sites/$SITE_ID -H "Authorization: Bearer $OTHER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"active"}'
```

Expected: `403 Forbidden`.

```bash
# Administrator creates a site on behalf of the contractor
curl -i -X POST http://localhost:3000/sites -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Admin-Created Site\",\"contractorId\":\"$CONTRACTOR_ID\",\"latitude\":-1.3,\"longitude\":36.8,\"address\":\"456 Admin Ave\"}"

# Administrator deletes the original site
curl -i -X DELETE http://localhost:3000/sites/$SITE_ID -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected: both `200`/`201`/`200`. Confirm the delete with `curl -i http://localhost:3000/sites/$SITE_ID -H "Authorization: Bearer $ADMIN_TOKEN"` → `404 Not Found`. Stop the dev server.

- [x] **Step 10: Commit**

```bash
git add src/sites src/app.module.ts
git commit -m "feat: add Sites module with ownership-based authorization"
```

---

### Task 4: InspectionRequests module

**Files:**
- Create: `src/inspection-requests/dto/create-inspection-request.dto.ts`
- Create: `src/inspection-requests/dto/update-inspection-request.dto.ts`
- Create: `src/inspection-requests/dto/accept-inspection-request.dto.ts`
- Create: `src/inspection-requests/inspection-requests.service.ts`
- Create: `src/inspection-requests/inspection-requests.controller.ts`
- Create: `src/inspection-requests/inspection-requests.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `AuditLogService.log(...)`, `AuthenticatedUser`, `@Roles()`/`@CurrentUser()` (all existing).
- Produces: `GET /inspection-requests`, `GET /inspection-requests/:id`, `POST /inspection-requests`, `PATCH /inspection-requests/:id`, `POST /inspection-requests/:id/accept`, `POST /inspection-requests/:id/reject`.

- [x] **Step 1: Write `CreateInspectionRequestDto`**

`src/inspection-requests/dto/create-inspection-request.dto.ts`:

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateInspectionRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  siteId: string;

  @ApiPropertyOptional({
    description: 'Administrator only — the contractor to create this request for. Ignored/forbidden for contractor callers, who always create for themselves.',
  })
  @IsOptional()
  @IsUUID()
  contractorId?: string;

  @ApiProperty({ example: '2026-08-10' })
  @IsDateString()
  requestedDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
```

- [x] **Step 2: Write `UpdateInspectionRequestDto`**

`src/inspection-requests/dto/update-inspection-request.dto.ts`:

```typescript
import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateInspectionRequestDto } from './create-inspection-request.dto';

export class UpdateInspectionRequestDto extends PartialType(
  OmitType(CreateInspectionRequestDto, ['contractorId'] as const),
) {}
```

- [x] **Step 3: Write `AcceptInspectionRequestDto`**

`src/inspection-requests/dto/accept-inspection-request.dto.ts`:

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class AcceptInspectionRequestDto {
  @ApiPropertyOptional({ description: 'Required when an administrator accepts on behalf of an engineer.' })
  @IsOptional()
  @IsUUID()
  engineerId?: string;
}
```

- [x] **Step 4: Write `InspectionRequestsService`**

`src/inspection-requests/inspection-requests.service.ts`:

```typescript
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InspectionRequest } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptInspectionRequestDto } from './dto/accept-inspection-request.dto';
import { CreateInspectionRequestDto } from './dto/create-inspection-request.dto';
import { UpdateInspectionRequestDto } from './dto/update-inspection-request.dto';

const REQUEST_INCLUDE = {
  site: {
    select: { id: true, name: true, address: true, latitude: true, longitude: true, geofenceRadius: true },
  },
  contractor: { select: { id: true, name: true, company: true } },
  engineer: { select: { id: true, name: true } },
} as const;

@Injectable()
export class InspectionRequestsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
  ) {}

  findAll(user: AuthenticatedUser) {
    const canSeeAll = this.canSeeAll(user);

    return this.prisma.inspectionRequest.findMany({
      where: canSeeAll ? undefined : { contractorId: user.userId },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const request = await this.findRequestOrThrow(id);
    this.assertCanRead(request, user);
    return request;
  }

  async create(dto: CreateInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const contractorId = this.resolveContractorId(dto.contractorId, user);
    await this.assertSiteExists(dto.siteId);

    const request = await this.prisma.inspectionRequest.create({
      data: {
        siteId: dto.siteId,
        contractorId,
        requestedDate: new Date(dto.requestedDate),
        notes: dto.notes,
      },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(
      user.userId,
      'inspection_request.created',
      'InspectionRequest',
      request.id,
      { siteId: dto.siteId, contractorId },
      ip,
    );

    return request;
  }

  async update(id: string, dto: UpdateInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertCanEdit(request, user);

    if (dto.siteId) {
      await this.assertSiteExists(dto.siteId);
    }

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: {
        siteId: dto.siteId,
        notes: dto.notes,
        requestedDate: dto.requestedDate ? new Date(dto.requestedDate) : undefined,
      },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(user.userId, 'inspection_request.updated', 'InspectionRequest', id, { ...dto }, ip);

    return updated;
  }

  async accept(id: string, dto: AcceptInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertPending(request);
    const engineerId = this.resolveEngineerId(dto, user);

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: { status: 'accepted', engineerId },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(
      user.userId,
      'inspection_request.accepted',
      'InspectionRequest',
      id,
      { engineerId },
      ip,
    );

    return updated;
  }

  async reject(id: string, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertPending(request);

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: { status: 'rejected' },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(user.userId, 'inspection_request.rejected', 'InspectionRequest', id, undefined, ip);

    return updated;
  }

  private canSeeAll(user: AuthenticatedUser): boolean {
    return user.roles.includes('engineer') || user.roles.includes('administrator');
  }

  private resolveContractorId(dtoContractorId: string | undefined, user: AuthenticatedUser): string {
    const isAdmin = user.roles.includes('administrator');

    if (isAdmin) {
      if (!dtoContractorId) {
        throw new ForbiddenException(
          'contractorId is required when an administrator creates an inspection request',
        );
      }
      return dtoContractorId;
    }

    if (dtoContractorId && dtoContractorId !== user.userId) {
      throw new ForbiddenException('Cannot create an inspection request for another contractor');
    }

    return user.userId;
  }

  private resolveEngineerId(dto: AcceptInspectionRequestDto, user: AuthenticatedUser): string {
    if (user.roles.includes('administrator')) {
      if (!dto.engineerId) {
        throw new ForbiddenException('engineerId is required when an administrator accepts a request');
      }
      return dto.engineerId;
    }
    return user.userId;
  }

  private assertPending(request: InspectionRequest) {
    if (request.status !== 'pending') {
      throw new ConflictException('Only pending requests can be accepted or rejected');
    }
  }

  private assertCanRead(request: InspectionRequest, user: AuthenticatedUser) {
    if (!this.canSeeAll(user) && request.contractorId !== user.userId) {
      throw new ForbiddenException('You do not have access to this inspection request');
    }
  }

  private assertCanEdit(request: InspectionRequest, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    if (request.contractorId !== user.userId) {
      throw new ForbiddenException('You do not own this inspection request');
    }
    if (request.status !== 'pending') {
      throw new ForbiddenException('This request can no longer be edited');
    }
  }

  private async assertSiteExists(siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
  }

  private async findRequestOrThrow(id: string) {
    const request = await this.prisma.inspectionRequest.findUnique({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    if (!request) {
      throw new NotFoundException('Inspection request not found');
    }
    return request;
  }
}
```

- [x] **Step 5: Write `InspectionRequestsController`**

`src/inspection-requests/inspection-requests.controller.ts`:

```typescript
import { Body, Controller, Get, Ip, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AcceptInspectionRequestDto } from './dto/accept-inspection-request.dto';
import { CreateInspectionRequestDto } from './dto/create-inspection-request.dto';
import { UpdateInspectionRequestDto } from './dto/update-inspection-request.dto';
import { InspectionRequestsService } from './inspection-requests.service';

@ApiTags('InspectionRequests')
@ApiBearerAuth()
@Controller('inspection-requests')
export class InspectionRequestsController {
  constructor(private inspectionRequestsService: InspectionRequestsService) {}

  @ApiOperation({ summary: 'List inspection requests (contractors see only their own; engineers/admins see all)' })
  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.inspectionRequestsService.findAll(user);
  }

  @ApiOperation({ summary: 'Get an inspection request by id' })
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.inspectionRequestsService.findOne(id, user);
  }

  @ApiOperation({ summary: 'Create an inspection request (contractor for self, or administrator for any contractor)' })
  @Roles('contractor', 'administrator')
  @Post()
  create(
    @Body() dto: CreateInspectionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionRequestsService.create(dto, user, ip);
  }

  @ApiOperation({ summary: 'Update an inspection request (owning contractor while pending, or administrator anytime)' })
  @Roles('contractor', 'administrator')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateInspectionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionRequestsService.update(id, dto, user, ip);
  }

  @ApiOperation({ summary: 'Accept a pending inspection request (engineer for self, or administrator for any engineer)' })
  @Roles('engineer', 'administrator')
  @Post(':id/accept')
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptInspectionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.inspectionRequestsService.accept(id, dto, user, ip);
  }

  @ApiOperation({ summary: 'Reject a pending inspection request' })
  @Roles('engineer', 'administrator')
  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.inspectionRequestsService.reject(id, user, ip);
  }
}
```

- [x] **Step 6: Write `InspectionRequestsModule`**

`src/inspection-requests/inspection-requests.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { InspectionRequestsController } from './inspection-requests.controller';
import { InspectionRequestsService } from './inspection-requests.service';

@Module({
  imports: [AuditLogModule],
  controllers: [InspectionRequestsController],
  providers: [InspectionRequestsService],
})
export class InspectionRequestsModule {}
```

- [x] **Step 7: Wire `InspectionRequestsModule` into `AppModule`**

Modify `src/app.module.ts` — add the import and add `InspectionRequestsModule` to the `imports` array (position doesn't affect behavior; place it alphabetically alongside the others, as shown below):

```typescript
import { InspectionRequestsModule } from './inspection-requests/inspection-requests.module';
// ...
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    PrismaModule,
    CommonModule,
    AuditLogModule,
    AuthModule,
    InspectionRequestsModule,
    SitesModule,
    UsersModule,
  ],
  // ...controllers/providers unchanged
})
```

- [x] **Step 8: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

- [x] **Step 9: Manually verify the full lifecycle + role-scoped visibility**

```bash
# Reuse $CONTRACTOR_TOKEN, $CONTRACTOR_ID from Task 3, and create a fresh engineer + a site to request against
curl -s -X POST http://localhost:3000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"requests-engineer@example.com","password":"password123","name":"Requests Engineer","roles":["engineer"]}'
# Copy accessToken into $ENGINEER_TOKEN

curl -s -X POST http://localhost:3000/sites -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Request Test Site","latitude":-1.28,"longitude":36.81,"address":"789 Test Street"}'
# Copy the site id into $SITE_ID
```

```bash
# Contractor creates a request
curl -i -X POST http://localhost:3000/inspection-requests -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":\"$SITE_ID\",\"requestedDate\":\"2026-08-15\",\"notes\":\"Foundation inspection\"}"
```

Expected: `201 Created`, `status: "pending"`, `engineer: null`. Copy the request id into `$REQUEST_ID`.

```bash
# A second, unrelated contractor cannot see it
curl -i http://localhost:3000/inspection-requests -H "Authorization: Bearer $OTHER_TOKEN"
curl -i http://localhost:3000/inspection-requests/$REQUEST_ID -H "Authorization: Bearer $OTHER_TOKEN"
```

Expected: list is empty (`[]` or excludes this request); single-record fetch returns `403 Forbidden`.

```bash
# The engineer can see and accept it
curl -i http://localhost:3000/inspection-requests -H "Authorization: Bearer $ENGINEER_TOKEN"
curl -i -X POST http://localhost:3000/inspection-requests/$REQUEST_ID/accept -H "Authorization: Bearer $ENGINEER_TOKEN"
```

Expected: list includes the request; accept returns `201`/`200` with `status: "accepted"`, `engineer: { name: "Requests Engineer" }`.

```bash
# Accepting again fails — no longer pending
curl -i -X POST http://localhost:3000/inspection-requests/$REQUEST_ID/accept -H "Authorization: Bearer $ENGINEER_TOKEN"
```

Expected: `409 Conflict`.

```bash
# The owning contractor can no longer edit it now that it's accepted
curl -i -X PATCH http://localhost:3000/inspection-requests/$REQUEST_ID -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"notes":"trying to edit after accept"}'
```

Expected: `403 Forbidden`.

```bash
# A fresh pending request can be rejected
curl -s -X POST http://localhost:3000/inspection-requests -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":\"$SITE_ID\",\"requestedDate\":\"2026-08-20\"}"
# Copy the new request id into $REQUEST_ID_2

curl -i -X POST http://localhost:3000/inspection-requests/$REQUEST_ID_2/reject -H "Authorization: Bearer $ENGINEER_TOKEN"
```

Expected: `200`/`201` with `status: "rejected"`, `engineer: null`. Stop the dev server.

- [x] **Step 10: Commit**

```bash
git add src/inspection-requests src/app.module.ts
git commit -m "feat: add InspectionRequests module with pending/accept/reject lifecycle"
```

---

## Self-Review Notes

- Spec coverage: Data model change (design §1, widened `Site.status`) — Task 3. Sites CRUD + authorization (design §2) — Task 3. InspectionRequests CRUD + role-scoped read + accept/reject lifecycle (design §3) — Task 4. Authorization notes (design §4, ownership checks in the service layer) — Tasks 3 & 4's `assertOwnerOrAdmin`/`assertCanRead`/`assertCanEdit`. Swagger/OpenAPI (design §5) — Task 1 (global setup) + Task 2 (retroactive decoration) + inline decoration in Tasks 3/4's own DTOs/controllers. The geofence helper (design §2) is implemented in Task 3 but deliberately has no call site yet — reserved for the future Inspections module, as agreed during brainstorming.
- No placeholders: every step has literal file contents and literal curl verification commands; no "add validation" or "TBD" steps remain.
- Type consistency check: `AuthenticatedUser` (existing, from `src/auth/types/jwt-payload.type.ts`) is the only user-context type referenced across Tasks 3–4, matching every other module. `AuditLogService.log(...)`'s 6-argument signature (existing) matches every call site in Tasks 3 and 4. `SitesService.isWithinGeofence(lat, lon, site)` and the exported `SITE_STATUSES`/`SiteStatus` are the only new cross-file exports from Task 3, and neither is referenced with a different name anywhere else in this plan.
