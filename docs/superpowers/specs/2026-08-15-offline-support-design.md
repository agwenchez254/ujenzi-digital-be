# Offline Support design

Date: 2026-08-15

## Purpose

Spec 6 of the original 6-spec sequence, and the last one. From the
original request: the inspection form should keep working when an
engineer loses connectivity mid-inspection (a real scenario — large
sites, basements, remote areas — after Spec 2's geofence/GPS check has
already confirmed they're on-site), saving locally and syncing to the
real backend automatically once connectivity returns.

A service worker already exists (`public/sw.js`, from Spec 2) but it's
push-notification-only — no offline caching, no write queueing. This
spec adds that.

## 1. Fix the offline / "Service Unavailable" conflict (prerequisite)

`baseApi.ts`'s `baseQueryWithStatusTracking` currently treats any
network-level failure (no HTTP status at all) the same as a 5xx: it sets
a global `backendUnavailable` flag, which `AppRoutes` uses to replace the
**entire app** with a full-screen `ServiceUnavailable` takeover. A
genuine "no network" condition produces exactly this same
no-status error from `fetch` — so today, the moment an engineer's device
loses signal, they'd be shown "Site unavailable, try again" and lose
access to the inspection form they were in the middle of, which is the
opposite of what this spec is for.

The fix checks `navigator.onLine` before deciding which flag to set: if
the browser reports no network interface at all, the app sets a new
`isOffline` flag instead of `backendUnavailable`, and `AppRoutes` does
**not** render `ServiceUnavailable` for that case — the current page
keeps rendering, backed by whatever's already in the RTK Query cache and,
for the inspection form specifically, the new offline queue (§2-3). A
backend that's genuinely down while the network itself is fine (a real
server crash, `navigator.onLine` still `true`) keeps today's behavior
unchanged — that's a different, legitimate failure mode this spec isn't
addressing.

## 2. IndexedDB-backed offline queue

New `src/lib/offlineQueue.ts`, using the `idb` package (a small
promise-based wrapper over IndexedDB — the raw IndexedDB callback API is
painful to use directly and `idb` is the de facto standard choice; no
other offline-storage library is already present in this codebase).

One object store, `pendingActions`:

```typescript
interface PendingAction {
  id: string; // client-generated uuid, used for de-duplication on retry
  type: 'draft' | 'photo' | 'submit';
  inspectionId: string;
  payload: Record<string, unknown>; // notes/riskLevel/coords, shape depends on type
  blob?: Blob; // only present for type: 'photo'
  createdAt: number;
}
```

Exposed functions: `enqueue(action)`, `getQueueForInspection(inspectionId)`,
`removeFromQueue(id)`, `getQueueCount()` (for the UI indicator in §5).
IndexedDB natively supports storing `Blob`s, so a photo taken offline is
stored as-is — no base64 encoding detour needed.

## 3. Wiring into `InspectionForm.tsx`

`handleSaveDraft`, `handleSubmit`, and `handleFileSelected` each already
call their respective RTK Query mutation directly. Each is wrapped so
that on a **network-level** failure (the same no-status signal as §1 —
not a 4xx, which is a real validation error the user needs to see and
fix, not something offline queueing can paper over) the action is
written to the queue instead of surfacing as an error, and the UI
optimistically reflects the change locally (the Tiptap editor content
and risk level already live in component state regardless; a queued
photo gets appended to the visible media list immediately via an
object URL created from the blob, marked "pending sync").

`useStartInspectionMutation` is untouched — starting still requires
connectivity, per the earlier decision. This is the one action in this
flow that mints the server-side `Inspection.id` everything else attaches
to, and it's also the moment (arriving on-site) an engineer is most
likely to actually have signal.

## 4. Sync manager

New `useOfflineSync()` hook, mounted once in `AppLayout` (rendered on
every authenticated page, so it's always active regardless of which page
the user is on when connectivity returns — not scoped to
`InspectionForm` alone, since a photo queued there might sync while
they've since navigated to `/inspections`).

Triggers a flush: on the browser's `online` event, and once on mount
(covers the case where the app was already loaded/reloaded while
offline and connectivity returns without an explicit event firing, e.g.
some mobile browsers). Flushing processes each inspection's queued
actions in strict FIFO order — draft saves before photos before submit,
since that's the order they were made in and a submit should reflect
whatever drafts/photos preceded it. Each action calls the exact same RTK
Query mutation the online path uses (`useSaveInspectionDraftMutation`,
`useUploadInspectionMediaMutation`, `useSubmitInspectionMutation`),
removed from the queue only after that call actually succeeds. A 4xx
during sync (the server rejecting a payload that looked fine when queued
— e.g. the inspection was closed by an admin in the meantime) surfaces a
toast naming the specific failure rather than silently dropping the
queued item, so the engineer knows to check it manually rather than
believing it synced.

## 5. UI

A small persistent banner in `AppLayout`, visible whenever `isOffline` is
true or the queue is non-empty: "Offline — N changes will sync" (or "N
changes pending sync" once back online but before the flush completes),
clearing once the queue empties. Queued photos in `MediaGallery` show a
"pending sync" badge until they're confirmed uploaded.

## 6. Testing

No automated tests, consistent with the rest of the project. Browser
verification: start an inspection while online, use DevTools' network
throttling to go offline, add draft notes/risk level/a photo/final
submit while offline, confirm they queue with a visible pending
indicator and the app stays on the inspection form (not
`ServiceUnavailable`), then go back online and confirm the queue flushes
in order and the toasts/indicators clear. Also verify a genuinely-down
backend (server stopped, network still up) still shows
`ServiceUnavailable` as before, confirming §1's fix didn't regress that
path.
