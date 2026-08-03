# Media design

Date: 2026-08-03

## Purpose

Fourth vertical slice of `ujenzi-digital-be`, following Sites +
InspectionRequests and Inspections (both fully implemented). Implements the
`Media` module from the overall design (`2026-08-02-ujenzi-digital-be-design.md`,
§4-5) — photo/video uploads attached to an inspection. This lands before
Reports (§6), which depends on Media for embedding photos in the generated
PDF. `InspectionTemplates` remains out of scope — a separate, independent
future slice.

## 1. Data model

No schema changes. `Media` already has every field needed (`inspectionId`,
`type`, `url`, `latitude`, `longitude`, `caption`), cascading delete from
`Inspection`.

`Media.type` (`photo | video`) is always derived server-side from the
uploaded file's mimetype prefix (`image/` → `photo`, `video/` → `video`) —
never accepted from the client, so it can't be spoofed to mismatch the
actual file content.

`Media` has no `mimeType` column, and this slice doesn't add one. The
download endpoint (§3) infers `Content-Type` from the stored file's
extension via a small hardcoded lookup table instead — keeps the schema
untouched, consistent with every prior slice's "no migration unless the
data genuinely needs a new column" approach.

## 2. Storage abstraction (shared, not Media-only)

Per the original design's explicit intent — "Storage access goes through a
`StorageService` interface (`save`, `read`, `delete`) so swapping to
S3-compatible storage later is a single adapter, not a rewrite" — this slice
introduces a shared `src/storage/` module rather than a Media-only one,
since the future Reports slice needs the identical disk-storage pattern for
generated PDFs (`uploads/reports/`).

```typescript
interface StorageService {
  save(buffer: Buffer, namespace: string, filename: string): Promise<string>; // returns the relative path, e.g. "media/<uuid>.jpg"
  read(relativePath: string): fs.ReadStream;
  delete(relativePath: string): Promise<void>;
}
```

The local disk implementation writes under `uploads/<namespace>/` (relative
to the project root); `namespace` lets Media use `uploads/media/` and a
future Reports slice use `uploads/reports/` through the same service.
`uploads/` is added to `.gitignore` (it doesn't currently have an entry).

`delete()` treats a missing file (`ENOENT`) as success rather than throwing
— deleting a `Media` row whose file was already removed (e.g. a prior
partial failure) should not block the DB delete.

## 3. Media module

| Route | Access | Notes |
|---|---|---|
| `GET /inspections/:inspectionId/media` | any authenticated user | Lists all `Media` rows for the inspection, newest first. |
| `GET /media/:id/file` | any authenticated user | Streams the file bytes with a `Content-Type` inferred from the stored extension. `404` if the `Media` row or its underlying file is missing. |
| `POST /inspections/:inspectionId/media` | engineer who owns the inspection, or administrator | Multipart upload via `FileInterceptor('file')`. Body fields: `latitude` (required), `longitude` (required), `caption?`. Only legal while `inspection.status === 'in_progress'` — `409 Conflict` otherwise, mirroring the Inspections module's "submitted = locked" rule. |
| `DELETE /media/:id` | engineer who owns the parent inspection, or administrator | Deletes the file via `StorageService.delete()`, then the `Media` row. |

**Upload validation:** `FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } })`
using multer's in-memory storage (a 25MB cap is small enough to hold safely
in memory) plus a `fileFilter` rejecting anything outside `image/*`/`video/*`
with a `400 Bad Request`. The stored filename is `randomUUID()` + the
original upload's extension (from its original filename).

**Ownership check:** identical shape to `InspectionsService.assertOwnerOrAdmin`
— load the parent `Inspection`, compare `inspection.engineerId` to the
caller, or allow `administrator`.

**Audit logging:** both mutations call `AuditLogService.log(...)`, matching
every other module in this API — `media.uploaded` on create, `media.deleted`
on delete.

## 4. New dependency

`@types/multer` (dev-only — `multer` itself already ships as a transitive
dependency of `@nestjs/platform-express`; only the TypeScript types for
`Express.Multer.File` are missing).

## 5. Swagger

`@ApiTags('Media')`, `@ApiBearerAuth()`, `@ApiOperation()` per route,
`@ApiConsumes('multipart/form-data')` + `@ApiBody()` describing the file +
form fields on the upload route — consistent with the rest of the API.

## 6. Testing

None in this pass, consistent with the rest of the project — manual `curl
-F` verification per task.
