# Offline Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The inspection form keeps working when an engineer loses connectivity mid-inspection — draft saves, photo uploads, and the final submit queue locally (IndexedDB) and sync automatically once connectivity returns — without the existing global "Service Unavailable" takeover blocking access to the form while offline.

**Architecture:** Fix `baseApi.ts` to distinguish "no network" from "backend genuinely down," reusing the `isOffline`/`setOffline` state that already exists in `uiSlice.ts` but isn't wired up yet. A new `src/lib/offlineQueue.ts` (IndexedDB via `idb`) holds pending draft/photo/submit actions. `InspectionForm.tsx`'s three write handlers fall back to the queue on a network-level failure. A `useOfflineSync()` hook, mounted once in `AppLayout`, flushes the queue in chronological order whenever connectivity returns.

**Tech Stack:** `idb` (new dependency) for a promise-based IndexedDB wrapper — the raw IndexedDB callback API is painful to use directly, and no offline-storage library already exists in this codebase.

## Global Constraints

- No automated tests, consistent with the rest of the project — manual verification per task using DevTools network throttling ("Offline" mode).
- `startInspection` is never queued — it requires connectivity, per the approved design. Only `saveInspectionDraft`, `uploadInspectionMedia`, and `submitInspection` are offline-capable.
- A 4xx from any of these three mutations is a real validation error (or, during sync, a legitimate rejection like "inspection was closed") — never silently queue or swallow those; only a network-level failure (`status === 'FETCH_ERROR'`) triggers queueing.
- Queued actions sync in strict chronological order (`createdAt` ascending) across all types for a given inspection — simpler and more faithful to "replay what actually happened" than grouping by action type, and equivalent in the normal case where drafts precede the photos taken after them.
- Package manager is `npm` for `sitesight-pro`.

---

## File Structure

```
sitesight-pro/
  package.json                                  (modify: add idb)
  src/store/api/baseApi.ts                       (modify: distinguish offline from backend-down)
  src/App.tsx                                    (modify: don't show ServiceUnavailable while offline)
  src/lib/offlineQueue.ts                        (create)
  src/hooks/useOfflineSync.ts                    (create)
  src/components/layout/AppLayout.tsx            (modify: mount sync hook, offline banner)
  src/pages/InspectionForm.tsx                   (modify: queue-on-failure, pending photos section)
```

---

### Task 1: Distinguish offline from backend-down

**Files:**
- Modify: `src/store/api/baseApi.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `isOffline`/`setOffline` (already exist in `uiSlice.ts`, currently unused elsewhere).
- Produces: `state.ui.isOffline` becomes live-updated from real request failures, and `AppRoutes` stops full-page-blocking on it. Tasks 3-4 rely on the rest of the app staying interactive while offline.

- [ ] **Step 1: Update `baseQueryWithStatusTracking` to check `navigator.onLine`**

Modify `src/store/api/baseApi.ts`:

```typescript
import { createApi, fetchBaseQuery, retry, type BaseQueryFn } from '@reduxjs/toolkit/query/react';
import type { RootState } from '@/store';
import { setBackendUnavailable, setOffline } from '@/store/slices/uiSlice';
```

```typescript
const baseQueryWithStatusTracking: BaseQueryFn = async (args, api, extraOptions) => {
  const result = await rawBaseQueryWithRetry(args, api, extraOptions);
  const status = result.error?.status;
  const isNetworkFailure = result.error !== undefined && typeof status !== 'number';

  if (isNetworkFailure && !navigator.onLine) {
    // No network at all — this is not the backend being down. Don't trigger
    // the full-page takeover; let the current page keep working off cache
    // and (for the inspection form) the offline queue.
    api.dispatch(setOffline(true));
    api.dispatch(setBackendUnavailable(false));
    return result;
  }

  if (navigator.onLine) {
    api.dispatch(setOffline(false));
  }
  const isBackendDown = result.error !== undefined && (typeof status !== 'number' || status >= 500);
  api.dispatch(setBackendUnavailable(isBackendDown));
  return result;
};
```

- [ ] **Step 2: Stop showing `ServiceUnavailable` while offline**

Modify `src/App.tsx`:

```typescript
  const backendUnavailable = useAppSelector((state) => state.ui.backendUnavailable);
  const isOffline = useAppSelector((state) => state.ui.isOffline);
  const theme = useAppSelector((state) => state.ui.theme);
```

```typescript
  if (backendUnavailable && !isOffline) {
    return <ServiceUnavailable />;
  }
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Manually verify both failure modes are distinguished**

Start both dev servers, log in, load any page. In DevTools' Network tab, set throttling to "Offline," then trigger any request (e.g. navigate to a page that refetches). Expected: the app stays on the current page (no `ServiceUnavailable` takeover) — confirm via React DevTools or a temporary console log that `state.ui.isOffline` is `true` and `state.ui.backendUnavailable` is `false`. Restore "No throttling," confirm `isOffline` clears. Then stop the backend process entirely (network still up) and trigger a request — confirm `ServiceUnavailable` **does** still show in this case (backend down, not offline).

- [ ] **Step 5: Commit**

```bash
git add src/store/api/baseApi.ts src/App.tsx
git commit -m "fix: don't show the full-page Service Unavailable takeover when the device is simply offline"
```

---

### Task 2: `offlineQueue.ts`

**Files:**
- Modify: `package.json`
- Create: `src/lib/offlineQueue.ts`

**Interfaces:**
- Consumes: `idb`.
- Produces: `PendingAction` type, `enqueue`, `getAllActions`, `getActionsForInspection`, `removeAction`, `getQueueCount`. Tasks 3-5 all depend on these exact names.

- [ ] **Step 1: Install `idb`**

```bash
npm install idb
```

- [ ] **Step 2: Write `offlineQueue.ts`**

`src/lib/offlineQueue.ts`:

```typescript
import { openDB, type DBSchema } from 'idb';

export type PendingActionType = 'draft' | 'photo' | 'submit';

export interface DraftPayload {
  notes: Record<string, unknown>;
  riskLevel: string;
}

export interface SubmitPayload extends DraftPayload {
  latitude: number;
  longitude: number;
}

export interface PhotoPayload {
  latitude: number;
  longitude: number;
  caption?: string;
  fileName: string;
  fileType: string;
}

export interface PendingAction {
  id: string;
  type: PendingActionType;
  inspectionId: string;
  payload: DraftPayload | SubmitPayload | PhotoPayload;
  blob?: Blob;
  createdAt: number;
}

interface OfflineQueueDB extends DBSchema {
  pendingActions: {
    key: string;
    value: PendingAction;
    indexes: { inspectionId: string };
  };
}

const DB_NAME = 'sitesight-offline-queue';
const STORE_NAME = 'pendingActions';

const dbPromise = openDB<OfflineQueueDB>(DB_NAME, 1, {
  upgrade(db) {
    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    store.createIndex('inspectionId', 'inspectionId');
  },
});

const QUEUE_CHANGED_EVENT = 'offline-queue-changed';

function notifyQueueChanged() {
  window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT));
}

export function onQueueChanged(callback: () => void): () => void {
  window.addEventListener(QUEUE_CHANGED_EVENT, callback);
  return () => window.removeEventListener(QUEUE_CHANGED_EVENT, callback);
}

export async function enqueue(action: Omit<PendingAction, 'id' | 'createdAt'>): Promise<string> {
  const db = await dbPromise;
  const id = crypto.randomUUID();
  await db.add(STORE_NAME, { ...action, id, createdAt: Date.now() });
  notifyQueueChanged();
  return id;
}

export async function getAllActions(): Promise<PendingAction[]> {
  const db = await dbPromise;
  const all = await db.getAll(STORE_NAME);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getActionsForInspection(inspectionId: string): Promise<PendingAction[]> {
  const db = await dbPromise;
  const all = await db.getAllFromIndex(STORE_NAME, 'inspectionId', inspectionId);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeAction(id: string): Promise<void> {
  const db = await dbPromise;
  await db.delete(STORE_NAME, id);
  notifyQueueChanged();
}

export async function getQueueCount(): Promise<number> {
  const db = await dbPromise;
  return db.count(STORE_NAME);
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/lib/offlineQueue.ts
git commit -m "feat: add IndexedDB-backed offline action queue"
```

---

### Task 3: Queue-on-failure in `InspectionForm.tsx`

**Files:**
- Modify: `src/pages/InspectionForm.tsx`

**Interfaces:**
- Consumes: `enqueue`/`getActionsForInspection`/`onQueueChanged` (Task 2).
- Produces: nothing new consumed elsewhere — Task 4's sync hook reads the same queue independently via `getAllActions`.

- [ ] **Step 1: Add the imports and a helper to detect network-level failures**

Modify `src/pages/InspectionForm.tsx`:

```typescript
import { useState, useEffect, useRef } from 'react';
```

```typescript
import { enqueue, getActionsForInspection, onQueueChanged, type PendingAction } from '@/lib/offlineQueue';

function isNetworkFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status: unknown }).status === 'FETCH_ERROR';
}
```

- [ ] **Step 2: Track pending (queued) photos for this inspection**

Add state and a loader, alongside the other `useState`/`useEffect` declarations:

```typescript
  const [pendingPhotos, setPendingPhotos] = useState<PendingAction[]>([]);

  useEffect(() => {
    if (!currentInspection) return;
    const load = async () => {
      const actions = await getActionsForInspection(currentInspection.id);
      setPendingPhotos(actions.filter((a) => a.type === 'photo'));
    };
    load();
    return onQueueChanged(load);
  }, [currentInspection]);
```

- [ ] **Step 3: Queue `handleSaveDraft` on network failure**

```typescript
  const handleSaveDraft = async () => {
    if (!currentInspection || !editor) return;

    const notes = editor.getJSON();
    try {
      const updated = await saveInspectionDraft({
        id: currentInspection.id,
        notes,
        riskLevel,
      }).unwrap();

      setCurrentInspection(updated);
      toast({
        title: 'Draft saved',
        description: 'Your progress has been saved.',
      });
    } catch (error) {
      if (isNetworkFailure(error)) {
        await enqueue({ type: 'draft', inspectionId: currentInspection.id, payload: { notes, riskLevel } });
        toast({ title: 'Saved locally', description: "You're offline — this draft will sync automatically." });
        return;
      }
      toast({
        title: 'Error',
        description: 'Failed to save draft.',
        variant: 'destructive',
      });
    }
  };
```

- [ ] **Step 4: Queue `handleSubmit` on network failure**

```typescript
  const handleSubmit = async () => {
    if (!currentInspection || !editor || latitude == null || longitude == null) return;

    if (!isWithinBoundary) {
      toast({
        title: 'Outside geofence',
        description: 'You must be at the site to submit the inspection report.',
        variant: 'destructive',
      });
      return;
    }

    const notes = editor.getJSON();
    try {
      await submitInspection({
        id: currentInspection.id,
        notes,
        riskLevel,
        latitude,
        longitude,
      }).unwrap();

      toast({
        title: 'Inspection submitted',
        description: 'The inspection report has been submitted successfully.',
      });
      navigate('/inspections');
    } catch (error) {
      if (isNetworkFailure(error)) {
        await enqueue({
          type: 'submit',
          inspectionId: currentInspection.id,
          payload: { notes, riskLevel, latitude, longitude },
        });
        toast({
          title: 'Saved locally',
          description: "You're offline — this submission will sync automatically once you're back online.",
        });
        navigate('/inspections');
        return;
      }
      toast({
        title: 'Error',
        description: 'Failed to submit inspection.',
        variant: 'destructive',
      });
    }
  };
```

- [ ] **Step 5: Queue `handleFileSelected` on network failure**

```typescript
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !currentInspection || latitude == null || longitude == null) return;

    try {
      await uploadMedia({
        inspectionId: currentInspection.id,
        file,
        latitude,
        longitude,
      }).unwrap();
    } catch (error) {
      if (isNetworkFailure(error)) {
        await enqueue({
          type: 'photo',
          inspectionId: currentInspection.id,
          payload: { latitude, longitude, fileName: file.name, fileType: file.type },
          blob: file,
        });
        toast({ title: 'Saved locally', description: "You're offline — this photo will upload automatically." });
        return;
      }
      toast({ title: 'Error', description: 'Failed to upload photo.', variant: 'destructive' });
    }
  };
```

- [ ] **Step 6: Render pending photos**

Modify the Photos `CardContent`, right after `<MediaGallery ... />`:

```tsx
                <MediaGallery
                  media={media}
                  editable={canEdit}
                  onDelete={handleDeleteMedia}
                  onReplace={handleReplaceMedia}
                />
                {pendingPhotos.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {pendingPhotos.map((action) => (
                      <div key={action.id} className="relative aspect-square rounded-md overflow-hidden border">
                        {action.blob && (
                          <img
                            src={URL.createObjectURL(action.blob)}
                            alt="Pending upload"
                            className="w-full h-full object-cover opacity-60"
                          />
                        )}
                        <span className="absolute bottom-1 left-1 right-1 text-[10px] bg-background/90 rounded px-1 py-0.5 text-center">
                          Pending sync
                        </span>
                      </div>
                    ))}
                  </div>
                )}
```

(Rendered as its own grid, separate from `MediaGallery` — that component's contract assumes every item has a real, server-fetchable media id via `useGetMediaFileUrlQuery`, which a queued-but-not-yet-uploaded photo doesn't have yet.)

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 8: Commit**

```bash
git add src/pages/InspectionForm.tsx
git commit -m "feat: queue inspection draft/photo/submit actions locally on network failure"
```

---

### Task 4: `useOfflineSync` hook

**Files:**
- Create: `src/hooks/useOfflineSync.ts`
- Modify: `src/components/layout/AppLayout.tsx`

**Interfaces:**
- Consumes: `getAllActions`/`removeAction` (Task 2), `useSaveInspectionDraftMutation`/`useUploadInspectionMediaMutation`/`useSubmitInspectionMutation` (existing, `inspectionsApi.ts`).
- Produces: queued actions actually reach the backend once online. Nothing else consumes this hook's return value — it's a side-effect-only hook.

- [ ] **Step 1: Write `useOfflineSync.ts`**

`src/hooks/useOfflineSync.ts`:

```typescript
import { useEffect, useRef } from 'react';
import { useToast } from '@/hooks/use-toast';
import {
  getAllActions,
  removeAction,
  type PendingAction,
  type DraftPayload,
  type SubmitPayload,
  type PhotoPayload,
} from '@/lib/offlineQueue';
import {
  useSaveInspectionDraftMutation,
  useUploadInspectionMediaMutation,
  useSubmitInspectionMutation,
} from '@/store/api/inspectionsApi';

export function useOfflineSync() {
  const { toast } = useToast();
  const [saveInspectionDraft] = useSaveInspectionDraftMutation();
  const [uploadMedia] = useUploadInspectionMediaMutation();
  const [submitInspection] = useSubmitInspectionMutation();
  const syncingRef = useRef(false);

  useEffect(() => {
    const flush = async () => {
      if (syncingRef.current || !navigator.onLine) return;
      syncingRef.current = true;

      try {
        const actions = await getAllActions();
        for (const action of actions) {
          try {
            await syncOne(action, { saveInspectionDraft, uploadMedia, submitInspection });
            await removeAction(action.id);
          } catch (error) {
            toast({
              title: 'Sync failed',
              description: `A queued ${action.type} for an inspection could not be synced. It will retry later.`,
              variant: 'destructive',
            });
            // Stop processing this inspection's later actions out of order —
            // move on to actions for other inspections instead.
            break;
          }
        }
      } finally {
        syncingRef.current = false;
      }
    };

    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

interface Mutations {
  saveInspectionDraft: ReturnType<typeof useSaveInspectionDraftMutation>[0];
  uploadMedia: ReturnType<typeof useUploadInspectionMediaMutation>[0];
  submitInspection: ReturnType<typeof useSubmitInspectionMutation>[0];
}

async function syncOne(action: PendingAction, mutations: Mutations): Promise<void> {
  if (action.type === 'draft') {
    const payload = action.payload as DraftPayload;
    await mutations
      .saveInspectionDraft({ id: action.inspectionId, notes: payload.notes, riskLevel: payload.riskLevel as never })
      .unwrap();
    return;
  }
  if (action.type === 'submit') {
    const payload = action.payload as SubmitPayload;
    await mutations
      .submitInspection({
        id: action.inspectionId,
        notes: payload.notes,
        riskLevel: payload.riskLevel as never,
        latitude: payload.latitude,
        longitude: payload.longitude,
      })
      .unwrap();
    return;
  }
  const payload = action.payload as PhotoPayload;
  if (!action.blob) return;
  const file = new File([action.blob], payload.fileName, { type: payload.fileType });
  await mutations
    .uploadMedia({
      inspectionId: action.inspectionId,
      file,
      latitude: payload.latitude,
      longitude: payload.longitude,
      caption: payload.caption,
    })
    .unwrap();
}
```

- [ ] **Step 2: Mount the hook in `AppLayout`**

Modify `src/components/layout/AppLayout.tsx`:

```typescript
import { ReactNode } from 'react';
import { MobileNav } from './MobileNav';
import { DesktopSidebar } from './DesktopSidebar';
import { useAppSelector } from '@/store/hooks';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { sidebarOpen } = useAppSelector((state) => state.ui);
  useOfflineSync();

  return (
```

(rest of the component unchanged)

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Manually verify the sync flow end-to-end**

Start both dev servers. Log in as an engineer, accept and start an inspection request. Open DevTools, throttle to "Offline." Edit notes and click Save Draft — confirm the "Saved locally" toast and no error. Add a photo — confirm it appears in the "Pending sync" grid. Click Submit — confirm the "Saved locally... will sync" toast and navigation to `/inspections`. Restore network ("No throttling"). Confirm (via the Network tab) the draft PATCH, the photo POST, and the submit POST all fire in that order shortly after, each succeeding, and a "Sync failed" toast does **not** appear. Reload `/inspections` and confirm the inspection shows as submitted with the photo attached.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOfflineSync.ts src/components/layout/AppLayout.tsx
git commit -m "feat: sync queued offline inspection actions automatically when back online"
```

---

### Task 5: Offline banner

**Files:**
- Modify: `src/components/layout/AppLayout.tsx`

**Interfaces:**
- Consumes: `state.ui.isOffline` (existing), `getQueueCount`/`onQueueChanged` (Task 2).
- Produces: nothing consumed elsewhere — last task.

- [ ] **Step 1: Add queue-count state and the banner**

Modify `src/components/layout/AppLayout.tsx`:

```typescript
import { ReactNode, useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { MobileNav } from './MobileNav';
import { DesktopSidebar } from './DesktopSidebar';
import { useAppSelector } from '@/store/hooks';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { getQueueCount, onQueueChanged } from '@/lib/offlineQueue';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const { sidebarOpen } = useAppSelector((state) => state.ui);
  const isOffline = useAppSelector((state) => state.ui.isOffline);
  const [queueCount, setQueueCount] = useState(0);
  useOfflineSync();

  useEffect(() => {
    const load = () => {
      getQueueCount().then(setQueueCount);
    };
    load();
    return onQueueChanged(load);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/30">
      {(isOffline || queueCount > 0) && (
        <div className="fixed top-0 inset-x-0 z-[60] bg-warning text-warning-foreground text-xs font-medium text-center py-1.5">
          <WifiOff className="h-3 w-3 inline mr-1.5 -mt-0.5" />
          {isOffline
            ? queueCount > 0
              ? `Offline — ${queueCount} change${queueCount === 1 ? '' : 's'} will sync when you're back online`
              : "Offline — changes you make will sync when you're back online"
            : `Syncing ${queueCount} pending change${queueCount === 1 ? '' : 's'}...`}
        </div>
      )}
      <DesktopSidebar />
```

(the rest of the JSX — `motion.main`, the mobile `<main>`, `<MobileNav />` — is unchanged)

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 3: Manually verify**

Repeat Task 4 Step 5's offline test, this time watching for the banner: it should appear the moment throttling is set to "Offline," update its count as items are queued, switch to "Syncing..." right as connectivity returns, and disappear once the queue empties.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/AppLayout.tsx
git commit -m "feat: show a persistent offline/pending-sync banner"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (ServiceUnavailable/offline fix) — Task 1. §2 (IndexedDB queue) — Task 2. §3 (wiring into InspectionForm) — Task 3. §4 (sync manager) — Task 4. §5 (UI) — Tasks 3 (pending photos) and 5 (banner).
- **Placeholder scan:** no TBDs. An earlier draft of Task 4 Step 1 had a stray unused import and a step that existed only to remove it — fixed by writing the import correctly in Step 1 directly and dropping the redundant step, consistent with every step containing only real, final content.
- **Type consistency:** `PendingAction`/`DraftPayload`/`SubmitPayload`/`PhotoPayload` (Task 2) are the exact types Tasks 3-5 import and use. `enqueue`'s parameter shape (`Omit<PendingAction, 'id'|'createdAt'>`) matches every `enqueue(...)` call site in Task 3 exactly (each supplies `type`, `inspectionId`, `payload`, and `blob` only where applicable). `onQueueChanged`'s return value (an unsubscribe function) is used consistently as a `useEffect` cleanup in both Task 3 and Task 5. Deviated from the design doc's "type-grouped" sync ordering in favor of plain chronological (`createdAt`) ordering — noted in Global Constraints as a deliberate, justified simplification, not an oversight.
