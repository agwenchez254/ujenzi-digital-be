# Realtime Infrastructure design

Date: 2026-08-13

## Purpose

Spec 2 of the 6-spec sequence (`2026-08-12-core-data-model-roles-design.md` was
Spec 1). Adds a WebSocket + Web Push layer to `ujenzi-digital-be`, wired to
the request/inspection lifecycle hooks that already exist
(`InspectionRequestsService.create/accept/reject`,
`InspectionsService.create/submit`), plus a minimal `sitesight-pro` consumer
that turns those events into RTK Query cache invalidation — proving the
infrastructure end-to-end without yet touching dashboard UX. The full
UI/permission rework (removing "Start Inspection" from developer/contractor,
live-updating request lists, the notes/photo flow) is Spec 3.

## 1. Why WebSockets *and* Web Push, not one or the other

gRPC is impractical for browser clients (needs a grpc-web proxy layer) and is
meant for service-to-service calls — ruled out during the original
brainstorming. WebSockets (Socket.IO) and Web Push solve different halves of
"realtime": Socket.IO delivers events while a tab is open; Web Push delivers
a system notification when it's closed or backgrounded. `RealtimeEventsService`
(§4) picks between them per target user based on live socket presence, so an
open tab is never double-notified.

## 2. WebSocket security model

Every connection is authenticated the same way REST requests are, and stays
authenticated for its whole lifetime — not just at handshake:

- **Handshake auth:** client connects with `io(WS_URL, { auth: { token: accessToken } })`.
  `RealtimeGateway.handleConnection` extracts `client.handshake.auth.token`
  and verifies it via `JwtService.verifyAsync(token, { secret:
  process.env.JWT_ACCESS_SECRET })` — the exact same secret/call shape
  `AuthService` already uses for REST. Missing/invalid/expired token →
  `client.disconnect(true)` immediately; no rooms are joined.
- **Zero client-supplied room names.** There is no "subscribe to room X"
  client event. After verifying identity, the server itself queries
  `SitePersonnel.userId` + `Site.contractorId` to compute which `site:*`
  rooms this user may join, and joins `role:*` rooms from the verified JWT's
  `roles` claim. A client can never request access to a site it isn't tied
  to, because it never gets to name the room at all.
- **Token-expiry enforcement.** A Socket.IO connection is long-lived, but
  access tokens expire in 15 minutes (`ACCESS_TOKEN_TTL` in
  `auth.service.ts`) — without action, a socket's trust would outlive its
  credential. At connect, the gateway reads the verified payload's `exp` and
  schedules `setTimeout(() => client.disconnect(true), (exp * 1000) - Date.now())`.
  The frontend reconnects with a fresh token after its normal
  `/auth/refresh` flow (§6).
- **Future client→server events** (none exist in this spec) must
  independently re-derive authorization from `client.data.user` (set at
  connect) plus a fresh DB check for the specific resource — never trust a
  client-claimed permission. Documented here as a rule for later specs.
- **CORS** on the gateway is restricted to `process.env.FRONTEND_ORIGIN`,
  matching `main.ts`'s REST CORS config — a secondary control; the handshake
  JWT check is the real boundary.

## 3. Room model

On successful connect, a socket joins:

- `user:${userId}` — always.
- `role:${role}` — one per role in the verified JWT payload (`engineer`,
  `contractor`, `site_representative`, `administrator`, `developer`).
- `site:${siteId}` — one per site the user is tied to, resolved via
  `SitePersonnel.findMany({ where: { userId } })` unioned with
  `Site.findMany({ where: { contractorId: userId } })` (the primary
  contractor FK predates `SitePersonnel` and isn't mirrored into it).

Events target `site:*` rooms (everyone tied to that site) for anything
already tied to a specific site, plus `role:engineer` + `role:administrator`
for a brand-new pending request (no engineer is tied to the site yet to
receive it via `site:*` alone).

## 4. `RealtimeEventsService` — the business logic's only touchpoint

```typescript
interface RealtimeTargets {
  siteIds?: string[];
  roles?: AppRole[];
  userIds?: string[];
}

class RealtimeEventsService {
  async emit(event: string, payload: unknown, targets: RealtimeTargets, push: { title: string; body: string; url?: string }): Promise<void>
}
```

`emit()` does two independent things:

1. **Live delivery:** builds the room name list (`site:${id}`, `role:${r}`,
   `user:${id}`) directly from `targets` and calls
   `this.gateway.server.to(rooms).emit(event, payload)`. Socket.IO's own
   room membership handles fan-out — no per-user resolution needed here.
2. **Push fallback:** resolves `targets` down to a concrete deduped set of
   user IDs (querying `SitePersonnel`/`Site.contractorId` for `siteIds`,
   `UserRole` for `roles`, unioned with any explicit `userIds`). For each
   resolved user, checks live presence via
   `this.gateway.server.sockets.adapter.rooms.get('user:' + userId)?.size`
   (room membership doubles as a presence table — no separate in-memory
   map to keep in sync). If absent, loads that user's `PushSubscription`
   rows and sends `push` via `PushService` to each.

Injected into `InspectionRequestsService` and `InspectionsService` (via a
new `RealtimeModule` export) — those services gain one `emit(...)` call per
existing lifecycle method, with no other changes to their logic.

## 5. Wired events

| Hook (existing method) | Event | Targets | Push title / body |
|---|---|---|---|
| `InspectionRequestsService.create` | `inspection-request.created` | `{siteIds:[siteId], roles:['engineer','administrator']}` | "New inspection request" / `${site.name} — requested by ${contractor.name}` |
| `InspectionRequestsService.accept` | `inspection-request.accepted` | `{siteIds:[siteId]}` | "Inspection request accepted" / `${site.name} — accepted by ${engineer.name}` |
| `InspectionRequestsService.reject` | `inspection-request.rejected` | `{siteIds:[siteId]}` | "Inspection request rejected" / `${site.name}` |
| `InspectionsService.create` (start) | `inspection.started` | `{siteIds:[siteId]}` | "Inspection started" / `${site.name}` |
| `InspectionsService.submit` | `inspection.submitted` | `{siteIds:[siteId]}` | "Inspection submitted" / `${site.name}` |

`payload` for every event is the same object the REST endpoint already
returns (the created/updated `InspectionRequest`/`Inspection` record with its
existing `include`) — the frontend doesn't need a second shape to learn.

## 6. Web Push

New Prisma model:

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

(`User` gains `pushSubscriptions PushSubscription[]`, same pairing pattern as
every other relation on `User`.)

New env vars: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (generated once via
`web-push`'s `generateVAPIDKeys()`), `VAPID_SUBJECT` (a `mailto:` contact —
placeholder value, operator fills in a real one before production use).

`PushService` wraps the `web-push` package: `sendNotification(subscription,
JSON.stringify({title, body, url}))`. When `web-push` throws with
`statusCode` 404 or 410 (subscription gone/expired on the browser's push
service), `PushService` deletes that `PushSubscription` row — self-cleaning,
no separate expiry sweep needed.

Routes (new `PushSubscriptionsController`, behind the existing
`JwtAuthGuard` like everything else — no new auth model):

| Route | Access | Notes |
|---|---|---|
| `GET /push/vapid-public-key` | `@Public()` | Returns `{ publicKey }`. Frontend needs this before it can call `pushManager.subscribe()`; fetched at runtime rather than duplicated into a `VITE_*` env var, so there's one source of truth. |
| `POST /push/subscribe` | any authenticated user | Body: `{ endpoint, keys: { p256dh, auth } }`. Upserts (by `endpoint`) a `PushSubscription` row for the caller. |
| `DELETE /push/subscribe` | any authenticated user | Body: `{ endpoint }`. Removes the caller's subscription for that endpoint (called on logout or when the browser's own `pushManager.unsubscribe()` succeeds). |

## 7. Frontend (sitesight-pro) — minimal consumer only

- `src/lib/realtime.ts`: `connectSocket(accessToken)` / `disconnectSocket()`.
  Called from the existing auth flow — connect right after login succeeds
  and after every token refresh (so a socket never runs past the token that
  authenticated it, matching §2's server-side expiry disconnect), disconnect
  on logout.
- On every received event, dispatch `store.dispatch(baseApi.util.invalidateTags([tag]))`
  where `inspection-request.*` → `'InspectionRequest'`, `inspection.*` →
  `'Inspection'` — both tags already exist in `baseApi.ts`. Existing screens
  (Pending Requests, Inspections list) refetch automatically; no new
  components in this spec.
- `public/sw.js`: hand-written, minimal — only a `push` listener
  (`self.registration.showNotification(data.title, { body: data.body, data: { url: data.url } })`)
  and a `notificationclick` listener (`clients.openWindow(event.notification.data.url)`).
  No caching, no offline logic. **Spec 6 (Offline Support) will introduce
  Workbox and must preserve or merge these two handlers into whatever it
  generates** — flagged here so that spec doesn't silently regress push.
- `src/lib/push.ts`: registers `sw.js`, and after login requests
  Notification permission once (native browser prompt); if granted, calls
  `pushManager.subscribe({ applicationServerKey: <fetched vapid public key> })`
  and `POST /push/subscribe`. On logout: `pushManager.getSubscription()` →
  `.unsubscribe()` → `DELETE /push/subscribe`.

## 8. New dependencies

Backend: `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io`,
`web-push`, `@types/web-push` (dev). Frontend: `socket.io-client`.

## 9. Testing

No automated tests, consistent with the rest of the project. Manual
verification: two browser sessions (e.g. via the Playwright MCP tool used
during Spec 1's UI check) logged in as a contractor and an engineer —
creating a request in one session should update the other's network log /
trigger a refetch without a manual page reload, confirming live delivery
end-to-end. Push delivery is verified separately by disconnecting a
session's socket (closing the tab) and confirming a system notification
still arrives for that user's next event.
