# Realtime Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Socket.IO gateway (JWT-authenticated, room-based, expiry-enforced) and a Web Push fallback, wire both to the existing inspection-request/inspection lifecycle hooks, and add a minimal sitesight-pro consumer that turns events into RTK Query cache invalidation.

**Architecture:** A new `RealtimeModule` (gateway + `RealtimeEventsService` + `PushService` + push-subscription CRUD) exported for `InspectionRequestsModule`/`InspectionsModule` to consume. Business-logic services gain one `realtimeEventsService.emit(...)` call per existing lifecycle method — no other logic changes. Frontend gains a socket connection lifecycle tied to existing auth actions (`sessionEstablished`/`sessionCleared`) via a small Redux middleware, plus a hand-written minimal service worker for push only.

**Tech Stack:** `@nestjs/websockets` + `@nestjs/platform-socket.io` (Socket.IO), `web-push` (VAPID), `socket.io-client` on the frontend. Package manager is **pnpm** (backend) / whichever the frontend already uses for `src/pages/SiteCreate.tsx`'s prior task (npm — confirmed working in Spec 1 Task 4).

## Global Constraints

- No automated tests in this pass (matches the rest of the project). Every task substitutes a manual verification step for the usual test-first cycle.
- The WebSocket gateway's `@WebSocketGateway({ cors: {...} })` decorator argument is evaluated at module-import time, **before** `ConfigModule.forRoot()` has run (`app.module.ts`'s own imports — including the chain that pulls in `RealtimeModule` — fully resolve before its own `@Module({...})` decorator body executes `ConfigModule.forRoot()`). `process.env.FRONTEND_ORIGIN` is therefore `undefined` at that exact moment, so the decorator must **not** read it directly. Use `cors: { origin: true, credentials: true }` (reflects the request's `Origin` header) instead — CORS here is secondary defense-in-depth; the JWT handshake check is the real security boundary, per the design.
- No client-supplied room names, ever. The server always computes room membership itself from a verified `AuthenticatedUser` plus a DB lookup (§ design doc 3). If a future task adds a client→server event, it must independently re-verify authorization for that specific action — never trust `client.data.user` alone for anything beyond identity.
- `PrismaModule` is `@Global()` — never add it to a feature module's `imports`, `PrismaService` is already injectable everywhere.
- Every mutation that already calls `AuditLogService.log(...)` keeps doing so unchanged; push-subscription CRUD is infrastructure (like auth refresh/logout), not a domain-entity mutation, so it is **not** audit-logged — matches the existing scoping (only Site/InspectionRequest/Inspection mutations are audited today).
- Package manager is `pnpm` for `ujenzi-digital-be`, `npm` for `sitesight-pro`.

---

## File Structure

```
ujenzi-digital-be/
  package.json                                          (modify: add deps)
  .env, .env.example                                    (modify: add VAPID_* vars)
  prisma/schema.prisma                                  (modify: PushSubscription model, User back-relation)
  prisma/migrations/<timestamp>_push_subscriptions/     (create: generated)
  src/realtime/
    realtime.gateway.ts                                 (create)
    realtime-events.service.ts                           (create)
    push.service.ts                                      (create)
    push-subscriptions.service.ts                        (create)
    push-subscriptions.controller.ts                     (create)
    realtime.module.ts                                   (create)
    dto/subscribe-push.dto.ts                             (create)
    dto/unsubscribe-push.dto.ts                           (create)
  src/inspection-requests/
    inspection-requests.module.ts                        (modify: import RealtimeModule)
    inspection-requests.service.ts                       (modify: emit on create/accept/reject)
  src/inspections/
    inspections.module.ts                                (modify: import RealtimeModule)
    inspections.service.ts                                (modify: emit on create/submit)
  src/app.module.ts                                       (modify: import RealtimeModule for its controller)

sitesight-pro/
  package.json                                            (modify: add socket.io-client)
  public/sw.js                                             (create)
  src/lib/realtime.ts                                      (create: connectSocket/disconnectSocket)
  src/lib/push.ts                                          (create: registerServiceWorker/subscribe/unsubscribe)
  src/store/realtimeMiddleware.ts                          (create)
  src/store/index.ts                                       (modify: add middleware)
```

---

### Task 1: Backend dependencies, env vars, VAPID keys

**Files:**
- Modify: `package.json`
- Modify: `.env`, `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` env vars; `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io`, `web-push` available to import. Every later task in this plan depends on these being installed.

- [ ] **Step 1: Install packages**

```bash
pnpm add @nestjs/websockets @nestjs/platform-socket.io socket.io web-push
pnpm add -D @types/web-push
```

- [ ] **Step 2: Generate VAPID keys**

```bash
pnpm dlx web-push generate-vapid-keys
```

Expected output: a `Public Key` and `Private Key` string pair.

- [ ] **Step 3: Add the new env vars**

Append to `.env` (use the real generated keys from Step 2):

```
VAPID_PUBLIC_KEY=<paste public key>
VAPID_PRIVATE_KEY=<paste private key>
VAPID_SUBJECT=mailto:admin@ujenzidigital.example
```

Append to `.env.example` (placeholders, not real keys):

```
VAPID_PUBLIC_KEY=replace-with-a-generated-vapid-public-key
VAPID_PRIVATE_KEY=replace-with-a-generated-vapid-private-key
VAPID_SUBJECT=mailto:admin@example.com
```

- [ ] **Step 4: Build**

```bash
pnpm run build
```

Expected: compiles cleanly (nothing imports the new packages yet, so this just confirms the install didn't break anything).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml .env.example
git commit -m "chore: add realtime dependencies (Socket.IO, web-push) and VAPID env vars"
```

(`.env` is gitignored — confirm with `git status` that it doesn't appear; do not commit it.)

---

### Task 2: `PushSubscription` Prisma model

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_push_subscriptions/migration.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.pushSubscription` client delegate with fields `{id, userId, endpoint, p256dh, auth, createdAt}`; `User.pushSubscriptions` back-relation. Task 4's `PushSubscriptionsService` and Task 5's `RealtimeEventsService` both call `prisma.pushSubscription.*` directly.

- [ ] **Step 1: Edit `prisma/schema.prisma`**

Add the model (place after `SitePersonnel`):

```prisma
model PushSubscription {
  id        String   @id @default(uuid())
  userId    String
  endpoint  String   @unique
  p256dh    String
  auth      String
  createdAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

Add the back-relation to `User` (alongside `sitePersonnel SitePersonnel[]`):

```prisma
  sitePersonnel     SitePersonnel[]
  pushSubscriptions PushSubscription[]
```

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm prisma migrate dev --name push_subscriptions
```

Expected: creates and applies `prisma/migrations/<timestamp>_push_subscriptions/`, regenerates the Prisma client. No hand-editing needed this time (plain table, no PostGIS/trigger involved).

- [ ] **Step 3: Verify**

```bash
docker compose exec postgres psql -U postgres -d ujenzi_digital -c "\d \"PushSubscription\""
```

Expected: shows the 5 columns, the unique index on `endpoint`, the index on `userId`, and the FK to `User`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add PushSubscription model"
```

---

### Task 3: `RealtimeGateway` — authenticated WebSocket connections

**Files:**
- Create: `src/realtime/realtime.gateway.ts`

**Interfaces:**
- Consumes: `JwtService` (from `@nestjs/jwt`), `PrismaService` (global), `AccessTokenPayload` (existing type from `src/auth/types/jwt-payload.type.ts`).
- Produces: `RealtimeGateway.server: Server` (public field) — Task 5's `RealtimeEventsService` calls `this.gateway.server.to(rooms).emit(...)` and reads `this.gateway.server.sockets.adapter.rooms` for presence checks. No Nest module registers this yet — Task 5 wires it into `RealtimeModule`.

- [ ] **Step 1: Write the gateway**

`src/realtime/realtime.gateway.ts`:

```typescript
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenPayload } from '../auth/types/jwt-payload.type';

interface VerifiedAccessTokenPayload extends AccessTokenPayload {
  exp: number;
}

@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }

    let payload: VerifiedAccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
    } catch {
      client.disconnect(true);
      return;
    }

    await client.join(`user:${payload.sub}`);
    await Promise.all(payload.roles.map((role) => client.join(`role:${role}`)));

    const siteIds = await this.resolveSiteIds(payload.sub);
    await Promise.all(siteIds.map((siteId) => client.join(`site:${siteId}`)));

    const delay = Math.max(payload.exp * 1000 - Date.now(), 0);
    client.data.expiryTimeout = setTimeout(() => client.disconnect(true), delay);
  }

  handleDisconnect(client: Socket): void {
    const expiryTimeout = client.data?.expiryTimeout as NodeJS.Timeout | undefined;
    if (expiryTimeout) {
      clearTimeout(expiryTimeout);
    }
  }

  private async resolveSiteIds(userId: string): Promise<string[]> {
    const [personnelSites, ownedSites] = await Promise.all([
      this.prisma.sitePersonnel.findMany({ where: { userId }, select: { siteId: true } }),
      this.prisma.site.findMany({ where: { contractorId: userId }, select: { id: true } }),
    ]);
    const ids = new Set<string>();
    personnelSites.forEach((p) => ids.add(p.siteId));
    ownedSites.forEach((s) => ids.add(s.id));
    return [...ids];
  }
}
```

- [ ] **Step 2: Temporarily register the gateway to test it standalone**

This gateway isn't wired into `RealtimeModule` until Task 5. To verify it in isolation, temporarily add it to `AppModule`'s `providers` array (not `imports` — it's a bare provider, no module yet):

Modify `src/app.module.ts` — add `import { RealtimeGateway } from './realtime/realtime.gateway';` and add `RealtimeGateway` to the `providers` array (alongside `AppService`). **Remember: this is temporary, reverted in Task 5's Step 1 once `RealtimeModule` exists.**

- [ ] **Step 3: Build and start the dev server**

```bash
pnpm run build
pnpm run start:dev
```

- [ ] **Step 4: Manually verify accept/reject behavior with a throwaway client**

```bash
mkdir -p /tmp/ws-verify && cd /tmp/ws-verify
npm init -y
npm install socket.io-client
```

Get a valid access token (reuse an existing user or sign one up):

```bash
curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"ws-verify@example.com","password":"password123","name":"WS Verify","roles":["contractor"]}'
# copy accessToken
```

`/tmp/ws-verify/test.js`:

```javascript
const { io } = require('socket.io-client');

const token = process.argv[2]; // pass '' for the invalid-token case
const socket = io('http://localhost:5000', { auth: { token } });

socket.on('connect', () => console.log('CONNECTED', socket.id));
socket.on('connect_error', (err) => console.log('CONNECT_ERROR', err.message));
socket.on('disconnect', (reason) => console.log('DISCONNECTED', reason));

setTimeout(() => process.exit(0), 2000);
```

```bash
node test.js "<the accessToken from signup>"
node test.js ""
node test.js "not-a-real-token"
```

Expected: first run prints `CONNECTED <id>` and stays connected for the full 2s; second and third runs print `DISCONNECTED transport close` (or similar) almost immediately — confirming missing/invalid tokens are rejected and a valid one is accepted. Stop the dev server, revert the temporary `AppModule` change from Step 2 back to no `RealtimeGateway` provider (it'll be re-added properly via `RealtimeModule` in Task 5).

- [ ] **Step 5: Commit**

```bash
git add src/realtime/realtime.gateway.ts
git commit -m "feat: add authenticated WebSocket gateway with JWT handshake and expiry disconnect"
```

(`src/app.module.ts` should show no diff at this point — the Step 2 temporary registration was reverted before committing.)

---

### Task 4: Web Push — `PushService` and subscription endpoints

**Files:**
- Create: `src/realtime/push.service.ts`
- Create: `src/realtime/dto/subscribe-push.dto.ts`
- Create: `src/realtime/dto/unsubscribe-push.dto.ts`
- Create: `src/realtime/push-subscriptions.service.ts`
- Create: `src/realtime/push-subscriptions.controller.ts`

**Interfaces:**
- Consumes: `PrismaService` (global), `web-push` package.
- Produces: `PushService.send(subscription: PushSubscription, content: {title, body, url?}): Promise<void>` — Task 5's `RealtimeEventsService` calls this. `GET /push/vapid-public-key`, `POST /push/subscribe`, `DELETE /push/subscribe` routes.

- [ ] **Step 1: Write `PushService`**

`src/realtime/push.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PushSubscription } from '@prisma/client';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

export interface PushContent {
  title: string;
  body: string;
  url?: string;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(private prisma: PrismaService) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT!,
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
  }

  async send(subscription: PushSubscription, content: PushContent): Promise<void> {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(content),
      );
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await this.prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => undefined);
      } else {
        this.logger.warn(`Push send failed for subscription ${subscription.id}: ${String(error)}`);
      }
    }
  }
}
```

- [ ] **Step 2: Write the DTOs**

`src/realtime/dto/subscribe-push.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, ValidateNested } from 'class-validator';

class PushKeysDto {
  @ApiProperty()
  @IsString()
  p256dh: string;

  @ApiProperty()
  @IsString()
  auth: string;
}

export class SubscribePushDto {
  @ApiProperty()
  @IsString()
  endpoint: string;

  @ApiProperty({ type: PushKeysDto })
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}
```

`src/realtime/dto/unsubscribe-push.dto.ts`:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class UnsubscribePushDto {
  @ApiProperty()
  @IsString()
  endpoint: string;
}
```

- [ ] **Step 3: Write `PushSubscriptionsService`**

`src/realtime/push-subscriptions.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubscribePushDto } from './dto/subscribe-push.dto';
import { UnsubscribePushDto } from './dto/unsubscribe-push.dto';

@Injectable()
export class PushSubscriptionsService {
  constructor(private prisma: PrismaService) {}

  async subscribe(userId: string, dto: SubscribePushDto): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: { userId, endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      update: { userId, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
    });
  }

  async unsubscribe(dto: UnsubscribePushDto): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint: dto.endpoint } });
  }

  getVapidPublicKey(): { publicKey: string | undefined } {
    return { publicKey: process.env.VAPID_PUBLIC_KEY };
  }
}
```

- [ ] **Step 4: Write `PushSubscriptionsController`**

`src/realtime/push-subscriptions.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SubscribePushDto } from './dto/subscribe-push.dto';
import { UnsubscribePushDto } from './dto/unsubscribe-push.dto';
import { PushSubscriptionsService } from './push-subscriptions.service';

@ApiTags('Push')
@Controller('push')
export class PushSubscriptionsController {
  constructor(private pushSubscriptionsService: PushSubscriptionsService) {}

  @ApiOperation({ summary: 'Get the VAPID public key needed to create a push subscription' })
  @Public()
  @Get('vapid-public-key')
  getVapidPublicKey() {
    return this.pushSubscriptionsService.getVapidPublicKey();
  }

  @ApiOperation({ summary: 'Register a push subscription for the current user' })
  @ApiBearerAuth()
  @Post('subscribe')
  subscribe(@Body() dto: SubscribePushDto, @CurrentUser() user: AuthenticatedUser) {
    return this.pushSubscriptionsService.subscribe(user.userId, dto);
  }

  @ApiOperation({ summary: 'Remove a push subscription (e.g. on logout)' })
  @ApiBearerAuth()
  @Delete('subscribe')
  unsubscribe(@Body() dto: UnsubscribePushDto) {
    return this.pushSubscriptionsService.unsubscribe(dto);
  }
}
```

- [ ] **Step 5: Temporarily register for standalone verification**

Same approach as Task 3 — temporarily add `PushSubscriptionsController` to `AppModule`'s `controllers` array and `PushService`, `PushSubscriptionsService` to its `providers` array. **Temporary — reverted in Task 5.**

- [ ] **Step 6: Build, run, and verify**

```bash
pnpm run build
pnpm run start:dev
```

```bash
curl -s http://localhost:5000/push/vapid-public-key
```

Expected: `{"publicKey":"<the key from Task 1>"}`.

```bash
TOKEN=$(curl -s -X POST http://localhost:5000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ws-verify@example.com","password":"password123"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

curl -i -X POST http://localhost:5000/push/subscribe -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"endpoint":"https://fcm.googleapis.com/fcm/send/test-endpoint","keys":{"p256dh":"test-p256dh","auth":"test-auth"}}'
```

Expected: `201 Created` (or `200`), empty/void body.

```bash
docker compose exec postgres psql -U postgres -d ujenzi_digital -c "SELECT \"userId\", endpoint FROM \"PushSubscription\";"
```

Expected: one row with the test endpoint.

```bash
curl -i -X DELETE http://localhost:5000/push/subscribe -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"endpoint":"https://fcm.googleapis.com/fcm/send/test-endpoint"}'
docker compose exec postgres psql -U postgres -d ujenzi_digital -c "SELECT COUNT(*) FROM \"PushSubscription\";"
```

Expected: delete succeeds, count is back to 0. Stop the dev server, revert the Step 5 temporary `AppModule` registrations.

- [ ] **Step 7: Commit**

```bash
git add src/realtime/push.service.ts src/realtime/dto src/realtime/push-subscriptions.service.ts src/realtime/push-subscriptions.controller.ts
git commit -m "feat: add Web Push service and subscription endpoints"
```

---

### Task 5: `RealtimeEventsService` and `RealtimeModule`

**Files:**
- Create: `src/realtime/realtime-events.service.ts`
- Create: `src/realtime/realtime.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `RealtimeGateway` (Task 3), `PushService` (Task 4), `PrismaService` (global).
- Produces: `RealtimeEventsService.emit(event: string, payload: unknown, targets: {siteIds?, roles?, userIds?}, push: {title, body, url?}): Promise<void>` — exported from `RealtimeModule`. Task 6's `InspectionRequestsService`/`InspectionsService` call this exact signature.

- [ ] **Step 1: Write `RealtimeEventsService`**

`src/realtime/realtime-events.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushContent, PushService } from './push.service';
import { RealtimeGateway } from './realtime.gateway';

export interface RealtimeTargets {
  siteIds?: string[];
  roles?: AppRole[];
  userIds?: string[];
}

@Injectable()
export class RealtimeEventsService {
  constructor(
    private gateway: RealtimeGateway,
    private prisma: PrismaService,
    private pushService: PushService,
  ) {}

  async emit(event: string, payload: unknown, targets: RealtimeTargets, push: PushContent): Promise<void> {
    const rooms = [
      ...(targets.siteIds ?? []).map((id) => `site:${id}`),
      ...(targets.roles ?? []).map((role) => `role:${role}`),
      ...(targets.userIds ?? []).map((id) => `user:${id}`),
    ];
    if (rooms.length) {
      this.gateway.server.to(rooms).emit(event, payload);
    }

    const userIds = await this.resolveUserIds(targets);
    await Promise.all(userIds.map((userId) => this.notifyIfOffline(userId, push)));
  }

  private async resolveUserIds(targets: RealtimeTargets): Promise<string[]> {
    const ids = new Set<string>(targets.userIds ?? []);

    if (targets.siteIds?.length) {
      const [personnel, sites] = await Promise.all([
        this.prisma.sitePersonnel.findMany({
          where: { siteId: { in: targets.siteIds }, userId: { not: null } },
          select: { userId: true },
        }),
        this.prisma.site.findMany({
          where: { id: { in: targets.siteIds } },
          select: { contractorId: true },
        }),
      ]);
      personnel.forEach((p) => p.userId && ids.add(p.userId));
      sites.forEach((s) => ids.add(s.contractorId));
    }

    if (targets.roles?.length) {
      const usersWithRole = await this.prisma.userRole.findMany({
        where: { role: { in: targets.roles } },
        select: { userId: true },
      });
      usersWithRole.forEach((u) => ids.add(u.userId));
    }

    return [...ids];
  }

  private isOnline(userId: string): boolean {
    const room = this.gateway.server.sockets.adapter.rooms.get(`user:${userId}`);
    return !!room && room.size > 0;
  }

  private async notifyIfOffline(userId: string, push: PushContent): Promise<void> {
    if (this.isOnline(userId)) {
      return;
    }
    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { userId } });
    await Promise.all(subscriptions.map((sub) => this.pushService.send(sub, push)));
  }
}
```

- [ ] **Step 2: Write `RealtimeModule`**

`src/realtime/realtime.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PushSubscriptionsController } from './push-subscriptions.controller';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { PushService } from './push.service';
import { RealtimeEventsService } from './realtime-events.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [JwtModule.register({})],
  controllers: [PushSubscriptionsController],
  providers: [RealtimeGateway, RealtimeEventsService, PushService, PushSubscriptionsService],
  exports: [RealtimeEventsService],
})
export class RealtimeModule {}
```

- [ ] **Step 3: Revert Task 3/4's temporary `AppModule` registrations, then wire `RealtimeModule` properly**

Modify `src/app.module.ts` — remove the temporary `RealtimeGateway`/`PushSubscriptionsController`/`PushService`/`PushSubscriptionsService` entries added during Tasks 3–4, and instead add `RealtimeModule` to the `imports` array:

```typescript
import { RealtimeModule } from './realtime/realtime.module';
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
    InspectionsModule,
    MediaModule,
    RealtimeModule,
    SitesModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
```

- [ ] **Step 4: Build and run**

```bash
pnpm run build
pnpm run start:dev
```

Expected: starts cleanly, `RealtimeModule dependencies initialized` appears in the log, `GET /push/vapid-public-key` still works (re-run the Task 4 curl check). Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/realtime/realtime-events.service.ts src/realtime/realtime.module.ts src/app.module.ts
git commit -m "feat: add RealtimeEventsService and wire RealtimeModule into AppModule"
```

---

### Task 6: Wire the 5 lifecycle hooks

**Files:**
- Modify: `src/inspection-requests/inspection-requests.module.ts`
- Modify: `src/inspection-requests/inspection-requests.service.ts`
- Modify: `src/inspections/inspections.module.ts`
- Modify: `src/inspections/inspections.service.ts`

**Interfaces:**
- Consumes: `RealtimeEventsService.emit(...)` (Task 5).
- Produces: nothing new consumed by later tasks — this is the last backend task; Task 7 only depends on these events existing (by name/payload shape), not on any TypeScript export.

- [ ] **Step 1: Wire `InspectionRequestsModule`**

Modify `src/inspection-requests/inspection-requests.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InspectionRequestsController } from './inspection-requests.controller';
import { InspectionRequestsService } from './inspection-requests.service';

@Module({
  imports: [AuditLogModule, RealtimeModule],
  controllers: [InspectionRequestsController],
  providers: [InspectionRequestsService],
})
export class InspectionRequestsModule {}
```

- [ ] **Step 2: Add `emit(...)` calls to `InspectionRequestsService`**

Modify `src/inspection-requests/inspection-requests.service.ts` — add the import and constructor param:

```typescript
import { RealtimeEventsService } from '../realtime/realtime-events.service';
// ...
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private realtimeEventsService: RealtimeEventsService,
  ) {}
```

In `create(...)`, right after the existing `auditLogService.log(...)` call, before `return request;`:

```typescript
    await this.realtimeEventsService.emit(
      'inspection-request.created',
      request,
      { siteIds: [request.siteId], roles: ['engineer', 'administrator'] },
      { title: 'New inspection request', body: `${request.site.name} — requested by ${request.contractor.name}` },
    );
```

In `accept(...)`, right after the existing `auditLogService.log(...)` call, before `return updated;`:

```typescript
    await this.realtimeEventsService.emit(
      'inspection-request.accepted',
      updated,
      { siteIds: [updated.siteId] },
      { title: 'Inspection request accepted', body: `${updated.site.name} — accepted by ${updated.engineer?.name ?? 'an engineer'}` },
    );
```

In `reject(...)`, right after the existing `auditLogService.log(...)` call, before `return updated;`:

```typescript
    await this.realtimeEventsService.emit(
      'inspection-request.rejected',
      updated,
      { siteIds: [updated.siteId] },
      { title: 'Inspection request rejected', body: updated.site.name },
    );
```

- [ ] **Step 3: Wire `InspectionsModule`**

Modify `src/inspections/inspections.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SitesModule } from '../sites/sites.module';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';

@Module({
  imports: [AuditLogModule, SitesModule, RealtimeModule],
  controllers: [InspectionsController],
  providers: [InspectionsService],
})
export class InspectionsModule {}
```

- [ ] **Step 4: Add `emit(...)` calls to `InspectionsService`**

Modify `src/inspections/inspections.service.ts` — add the import and constructor param:

```typescript
import { RealtimeEventsService } from '../realtime/realtime-events.service';
// ...
  constructor(
    private prisma: PrismaService,
    private sitesService: SitesService,
    private auditLogService: AuditLogService,
    private realtimeEventsService: RealtimeEventsService,
  ) {}
```

In `create(...)` (starts an inspection), right after the existing `auditLogService.log(...)` call, before `return inspection;`:

```typescript
    await this.realtimeEventsService.emit(
      'inspection.started',
      inspection,
      { siteIds: [inspection.siteId] },
      { title: 'Inspection started', body: inspection.site.name },
    );
```

In `submit(...)`, right after the existing `auditLogService.log(...)` call, before `return updated;`:

```typescript
    await this.realtimeEventsService.emit(
      'inspection.submitted',
      updated,
      { siteIds: [updated.siteId] },
      { title: 'Inspection submitted', body: updated.site.name },
    );
```

- [ ] **Step 5: Build**

```bash
pnpm run build
```

- [ ] **Step 6: Manually verify end-to-end with two throwaway socket clients**

```bash
pnpm run start:dev
```

Reuse `/tmp/ws-verify` from Task 3. Sign up a fresh engineer and a fresh contractor, create a site (contractor), and connect both as listeners:

```bash
cd /tmp/ws-verify
curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"realtime-engineer@example.com","password":"password123","name":"Realtime Engineer","roles":["engineer"]}'
# copy accessToken -> ENGINEER_TOKEN

curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"realtime-contractor@example.com","password":"password123","name":"Realtime Contractor","roles":["contractor"]}'
# copy accessToken -> CONTRACTOR_TOKEN

curl -s -X POST http://localhost:5000/sites -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Realtime Test Site","latitude":-1.28,"longitude":36.81,"address":"1 Test Way"}'
# copy site id -> SITE_ID
```

`/tmp/ws-verify/listen.js`:

```javascript
const { io } = require('socket.io-client');
const token = process.argv[2];
const socket = io('http://localhost:5000', { auth: { token } });
socket.on('connect', () => console.log('CONNECTED'));
socket.onAny((event, payload) => console.log('EVENT', event, JSON.stringify(payload).slice(0, 200)));
setTimeout(() => process.exit(0), 15000);
```

```bash
node listen.js "$ENGINEER_TOKEN" &
sleep 1
curl -s -X POST http://localhost:5000/inspection-requests -H "Authorization: Bearer $CONTRACTOR_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"siteId\":\"$SITE_ID\",\"requestedDate\":\"2026-08-20\"}"
wait
```

Expected: the listener process prints `CONNECTED` then `EVENT inspection-request.created {...}` within a second or two of the `curl` call. Repeat for `accept`/`reject` (listen as the contractor's own `$CONTRACTOR_TOKEN`, since that request's `site:*` room includes the contractor via `Site.contractorId`) to confirm those two events also arrive. Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/inspection-requests src/inspections
git commit -m "feat: emit realtime events on inspection-request and inspection lifecycle transitions"
```

---

### Task 7: sitesight-pro — socket connection and cache invalidation

**Files:**
- Modify: `package.json` (sitesight-pro)
- Create: `src/lib/realtime.ts`
- Create: `src/store/realtimeMiddleware.ts`
- Modify: `src/store/index.ts`

**Interfaces:**
- Consumes: `sessionEstablished`/`sessionCleared` actions (existing, `src/store/slices/authSlice.ts`), `baseApi.util.invalidateTags` (existing, RTK Query).
- Produces: `connectSocket(token: string, onEvent: (event: string, payload: unknown) => void)`, `disconnectSocket()` — exported from `src/lib/realtime.ts`, used only by `realtimeMiddleware.ts`.

- [ ] **Step 1: Install `socket.io-client`**

```bash
npm install socket.io-client
```

- [ ] **Step 2: Write `src/lib/realtime.ts`**

```typescript
import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function connectSocket(token: string, onEvent: (event: string, payload: unknown) => void): void {
  disconnectSocket();
  socket = io(import.meta.env.VITE_API_URL, { auth: { token } });
  socket.onAny(onEvent);
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
```

- [ ] **Step 3: Write `src/store/realtimeMiddleware.ts`**

```typescript
import type { Middleware } from '@reduxjs/toolkit';
import { baseApi } from './api/baseApi';
import { connectSocket, disconnectSocket } from '@/lib/realtime';
import { sessionCleared, sessionEstablished } from './slices/authSlice';

const TAG_BY_EVENT_PREFIX: Record<string, 'InspectionRequest' | 'Inspection'> = {
  'inspection-request': 'InspectionRequest',
  inspection: 'Inspection',
};

function tagForEvent(event: string): 'InspectionRequest' | 'Inspection' | undefined {
  const prefix = event.split('.')[0];
  return TAG_BY_EVENT_PREFIX[prefix];
}

export const realtimeMiddleware: Middleware = (store) => (next) => (action) => {
  if (sessionEstablished.match(action)) {
    connectSocket(action.payload.accessToken, (event) => {
      const tag = tagForEvent(event);
      if (tag) {
        store.dispatch(baseApi.util.invalidateTags([tag]));
      }
    });
  }
  if (sessionCleared.match(action)) {
    disconnectSocket();
  }
  return next(action);
};
```

- [ ] **Step 4: Wire the middleware into the store**

Modify `src/store/index.ts`:

```typescript
import { configureStore } from '@reduxjs/toolkit';
import { baseApi } from './api/baseApi';
import authReducer from './slices/authSlice';
import reportsReducer from './slices/reportsSlice';
import uiReducer from './slices/uiSlice';
import { realtimeMiddleware } from './realtimeMiddleware';

export const store = configureStore({
  reducer: {
    [baseApi.reducerPath]: baseApi.reducer,
    auth: authReducer,
    reports: reportsReducer,
    ui: uiReducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware, realtimeMiddleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

- [ ] **Step 5: Manually verify in two browser sessions**

Start both dev servers (`ujenzi-digital-be`: `pnpm run start:dev`; `sitesight-pro`: whichever instance is already running on port 8080, per Spec 1's note — don't start a duplicate). Open two browser profiles/windows (or one normal + one incognito) logged in as a contractor and an engineer tied to the same site. In the contractor's session, submit a new inspection request. In the engineer's session's DevTools Network tab, confirm a `GET /inspection-requests` refetch fires within a couple seconds, with no manual page reload. Confirm the browser's WebSocket frames (DevTools → Network → WS) show the `inspection-request.created` event arriving.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/realtime.ts src/store/realtimeMiddleware.ts src/store/index.ts
git commit -m "feat: connect to realtime events and invalidate RTK Query cache on updates"
```

---

### Task 8: sitesight-pro — service worker and push subscription

**Files:**
- Create: `public/sw.js`
- Create: `src/lib/push.ts`
- Modify: `src/store/realtimeMiddleware.ts`

**Interfaces:**
- Consumes: `GET /push/vapid-public-key`, `POST/DELETE /push/subscribe` (Task 4), `import.meta.env.VITE_API_URL` (existing).
- Produces: nothing consumed by other tasks in this plan — this is the last task.

- [ ] **Step 1: Write the minimal service worker**

`public/sw.js`:

```javascript
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'SiteInspect', body: '' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

- [ ] **Step 2: Write `src/lib/push.ts`**

```typescript
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function apiFetch(path: string, options: RequestInit, token: string): Promise<Response> {
  return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    ...options,
    headers: { ...options.headers, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    return null;
  }
  return navigator.serviceWorker.register('/sw.js');
}

export async function subscribeToPush(token: string): Promise<void> {
  if (!('PushManager' in window)) {
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return;
  }

  const registration = await registerServiceWorker();
  if (!registration) {
    return;
  }

  const { publicKey } = await fetch(`${import.meta.env.VITE_API_URL}/push/vapid-public-key`).then((r) => r.json());
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const key = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await apiFetch('/push/subscribe', { method: 'POST', body: JSON.stringify(key) }, token);
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe();
  }
}
```

- [ ] **Step 3: Call it from `realtimeMiddleware.ts`**

Modify `src/store/realtimeMiddleware.ts` — add the import and calls:

```typescript
import { subscribeToPush, unsubscribeFromPush } from '@/lib/push';
// ...
  if (sessionEstablished.match(action)) {
    connectSocket(action.payload.accessToken, (event) => {
      const tag = tagForEvent(event);
      if (tag) {
        store.dispatch(baseApi.util.invalidateTags([tag]));
      }
    });
    void subscribeToPush(action.payload.accessToken);
  }
  if (sessionCleared.match(action)) {
    disconnectSocket();
    void unsubscribeFromPush();
  }
```

- [ ] **Step 4: Manually verify**

Run the frontend dev server, log in, and accept the browser's notification permission prompt. Confirm in DevTools → Application → Service Workers that `sw.js` is registered and activated, and in Application → Push Messaging (or Network) that a subscription was created. Confirm `POST /push/subscribe` fired (Network tab) with a `201`/`200`. Log out and confirm `DELETE /push/subscribe` fires.

To verify actual push delivery: close the tab entirely (killing the socket connection so `notifyIfOffline` takes the push path), then from another session trigger one of the 5 events for a site this user is tied to. Expected: a native OS notification appears; clicking it opens the app.

- [ ] **Step 5: Commit**

```bash
git add public/sw.js src/lib/push.ts src/store/realtimeMiddleware.ts
git commit -m "feat: add service worker and push subscription registration"
```

---

## Self-Review Notes

- **Spec coverage:** Security model (design §2) — Task 3's JWT handshake check + expiry-timeout disconnect, Global Constraints' no-client-room-names rule. Room model (design §3) — Task 3's `resolveSiteIds` + role/user joins. `RealtimeEventsService` (design §4) — Task 5, exact `emit` signature matches. All 5 wired events (design §5) — Task 6, one per row of the design's table, same targets and push copy. Web Push + subscription endpoints (design §6) — Task 4. Frontend consumer (design §7) — Tasks 7–8, including the explicit note that Spec 6 must preserve `sw.js`'s two handlers. Dependencies (design §8) — Task 1 (backend) + Task 7 Step 1 (frontend). Testing approach (design §9) — Task 6 Step 6 (two-socket-client check) and Task 7 Step 5 (two-browser-session check) cover the "live delivery across two sessions" verification; Task 8 Step 4 covers the push-when-offline case.
- **Placeholder scan:** No "TBD"/"add validation" phrasing. `VAPID_SUBJECT`'s placeholder email is an explicitly-flagged operator-fill-in value (Task 1 Step 3), not a spec gap. Every code step has literal file contents.
- **Type consistency check:** `RealtimeTargets` (siteIds/roles/userIds, all optional) is defined once in `realtime-events.service.ts` and used with the exact same shape in every `emit(...)` call site across Task 6. `PushContent` (title/body/url?) is defined in `push.service.ts`, re-exported implicitly via `RealtimeEventsService`'s import, and every Task 6 call site's fourth argument matches that shape. The gateway's `process.env.FRONTEND_ORIGIN`-timing pitfall is called out once as a Global Constraint rather than re-explained per task. Frontend: `connectSocket`'s `onEvent` callback signature (`(event: string, payload: unknown) => void`) matches exactly how `realtimeMiddleware.ts` calls it, and `sessionEstablished.match(action)` relies on `authSlice.ts`'s actual action creator (confirmed via the file read during planning) rather than an assumed name.
