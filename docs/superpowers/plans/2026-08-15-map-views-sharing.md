# Map Views & Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a map view of sites (all sites for administrators, tied sites for everyone else) and a public, unauthenticated, per-site share page that renders correctly as a social-platform link-preview card.

**Architecture:** A lightweight `GET /sites/map` endpoint reuses the existing `resolveTiedSiteIds` scoping helper. A new server-rendered (not React) `GET /public/sites/:id` route returns plain HTML with Open Graph tags and a Mapbox static image. The frontend gets a new `/sites-map` page (`react-map-gl`/`mapbox-gl`) and a Share button on `SiteDetail.tsx`.

**Tech Stack:** NestJS 11 (`@Res()` raw-HTML response, mirroring the existing pattern in `media.controller.ts`'s file-streaming route), Mapbox (Static Images API server-side, `mapbox-gl`/`react-map-gl` client-side) using the Mapbox public token already configured in both projects' `.env`.

## Global Constraints

- No automated tests, consistent with the rest of the project — manual curl/browser verification per task.
- The public share page exposes only name, address, status, and construction phase — never contractor, personnel, approvals, or plot/legal identifiers.
- Any site-supplied string (name, address) interpolated into the server-rendered HTML must be HTML-escaped — this is the one place in the app that builds raw HTML by hand, so it's the one place an unescaped field becomes a stored-XSS vector.
- The mobile bottom nav (`MobileNav.tsx`) is a fixed 5-slot bar (Dashboard/Sites/Inspections/Reports/Profile) — the new map page is added to the desktop sidebar only, not mobile nav, to avoid crowding it to 6 items.
- Package manager is `pnpm` for `ujenzi-digital-be`, `npm` for `sitesight-pro`.

---

## File Structure

```
ujenzi-digital-be/
  src/main.ts                                    (modify: helmet CSP img-src for Mapbox)
  src/sites/sites.service.ts                     (modify: add findMapPins)
  src/sites/sites.controller.ts                  (modify: add GET /sites/map)
  src/sites/public-sites.controller.ts           (create)
  src/sites/sites.module.ts                      (modify: register PublicSitesController)

sitesight-pro/
  package.json                                   (modify: add mapbox-gl, react-map-gl)
  src/store/api/sitesApi.ts                      (modify: add MapPin type + getMapPins query)
  src/pages/SitesMap.tsx                         (create)
  src/App.tsx                                    (modify: add /sites-map route)
  src/components/layout/DesktopSidebar.tsx       (modify: add nav entry)
  src/pages/SiteDetail.tsx                       (modify: add Share button)
```

---

### Task 1: Backend — `GET /sites/map`

**Files:**
- Modify: `src/sites/sites.service.ts`
- Modify: `src/sites/sites.controller.ts`

**Interfaces:**
- Consumes: `resolveTiedSiteIds` (existing, same file).
- Produces: `SitesService.findMapPins(user): Promise<MapPin[]>`, `GET /sites/map`. Task 4's frontend `getMapPins` query consumes this exact shape.

- [ ] **Step 1: Add the `MapPin` interface and `findMapPins` method**

Modify `src/sites/sites.service.ts` — add near the top, alongside `SiteWithinRadiusRow`:

```typescript
export interface MapPin {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  status: string;
  address: string;
  constructionPhase: string | null;
}
```

Add the method, near `resolveTiedSiteIds`:

```typescript
  async findMapPins(user: AuthenticatedUser): Promise<MapPin[]> {
    const where = user.roles.includes('administrator')
      ? {}
      : { id: { in: await this.resolveTiedSiteIds(user.userId) } };

    const sites = await this.prisma.site.findMany({
      where,
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        status: true,
        address: true,
        constructionPhase: true,
      },
    });

    return sites.map((site) => ({
      id: site.id,
      name: site.name,
      latitude: Number(site.latitude),
      longitude: Number(site.longitude),
      status: site.status,
      address: site.address,
      constructionPhase: site.constructionPhase,
    }));
  }
```

- [ ] **Step 2: Add the route**

Modify `src/sites/sites.controller.ts` — add the import and, placed **before** `findOne(':id')` (so `/sites/map` isn't swallowed by the `:id` param route):

```typescript
import { CurrentUser } from '../common/decorators/current-user.decorator';
```

(merge into the existing import line if `CurrentUser` isn't already imported there — check first; it already is, from `create`/`update`/`remove`)

```typescript
  @ApiOperation({ summary: 'List map pins (all sites for administrators, tied sites for everyone else)' })
  @Get('map')
  findMapPins(@CurrentUser() user: AuthenticatedUser) {
    return this.sitesService.findMapPins(user);
  }

  @ApiOperation({ summary: 'Get a site by id' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sitesService.findOne(id);
  }
```

- [ ] **Step 3: Build**

```bash
pnpm run build
```

- [ ] **Step 4: Manually verify role scoping**

```bash
pnpm run start:dev
```

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:5000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@ujenzidigital.example","password":"<the seeded admin password>"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
curl -s http://localhost:5000/sites/map -H "Authorization: Bearer $ADMIN_TOKEN" | head -c 500

CONTRACTOR_TOKEN=$(curl -s -X POST http://localhost:5000/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"map-test-contractor@example.com","password":"password123","name":"Map Test","roles":["contractor"]}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
curl -s http://localhost:5000/sites/map -H "Authorization: Bearer $CONTRACTOR_TOKEN"
```

Expected: the admin call returns every site in the database (compare count against `GET /sites`); the freshly-signed-up contractor (owns no sites yet) gets `[]`. Stop the dev server, clean up the test user.

- [ ] **Step 5: Commit**

```bash
git add src/sites/sites.service.ts src/sites/sites.controller.ts
git commit -m "feat: add GET /sites/map for pin data, scoped by role"
```

---

### Task 2: Backend — CSP allowance for the Mapbox static image

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: an `img-src` CSP directive permitting `https://api.mapbox.com` — Task 3's server-rendered page embeds an `<img>` from that origin, and Helmet's default CSP (`img-src 'self' data:`) would otherwise silently block it in any browser that enforces CSP.

- [ ] **Step 1: Configure Helmet's CSP directives**

Modify `src/main.ts`:

```typescript
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'img-src': ["'self'", 'data:', 'https://api.mapbox.com'],
        },
      },
    }),
  );
```

(replaces the current bare `app.use(helmet());`)

- [ ] **Step 2: Build**

```bash
pnpm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: allow Mapbox static images in the CSP img-src directive"
```

---

### Task 3: Backend — `GET /public/sites/:id`

**Files:**
- Create: `src/sites/public-sites.controller.ts`
- Modify: `src/sites/sites.module.ts`

**Interfaces:**
- Consumes: `PrismaService` (direct query, not `SitesService`, since this needs a distinct minimal `select` and no auth-aware logic), `ConfigService` (`MAPBOX_TOKEN`, `FRONTEND_ORIGIN`).
- Produces: server-rendered HTML at `/public/sites/:id`. Task 5's Share button links here directly (no frontend route involved).

- [ ] **Step 1: Write `public-sites.controller.ts`**

`src/sites/public-sites.controller.ts`:

```typescript
import { Controller, Get, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

@ApiTags('Public Sites')
@Controller('public/sites')
export class PublicSitesController {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  @ApiOperation({ summary: 'Public, unauthenticated share page for a site (server-rendered HTML with Open Graph tags)' })
  @Public()
  @Get(':id')
  async getPublicPage(@Param('id') id: string, @Res() res: Response) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      select: {
        name: true,
        address: true,
        status: true,
        constructionPhase: true,
        latitude: true,
        longitude: true,
      },
    });

    if (!site) {
      res.status(404).type('html').send(
        '<!DOCTYPE html><html><head><title>Site not found</title></head>' +
          '<body><h1>Site not found</h1><p>This link may be out of date.</p></body></html>',
      );
      return;
    }

    const name = escapeHtml(site.name);
    const address = escapeHtml(site.address);
    const status = escapeHtml(site.status);
    const description = escapeHtml(`${site.address} — ${site.status}`);
    const lat = Number(site.latitude);
    const lon = Number(site.longitude);
    const mapboxToken = this.configService.get<string>('MAPBOX_TOKEN');
    const mapImageUrl =
      `https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/` +
      `pin-s+f00(${lon},${lat})/${lon},${lat},14/600x315?access_token=${mapboxToken}`;
    const pageUrl = `${this.configService.get<string>('FRONTEND_ORIGIN')}/public/sites/${id}`;

    res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${name} — Ujenzi Digital</title>
  <meta property="og:title" content="${name}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${mapImageUrl}" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
    img { width: 100%; border-radius: 8px; }
    h1 { font-size: 1.5rem; }
    .status { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #eee; font-size: 0.85rem; }
  </style>
</head>
<body>
  <img src="${mapImageUrl}" alt="Map showing ${name}" />
  <h1>${name}</h1>
  <p>${address}</p>
  <p><span class="status">${status}</span>${site.constructionPhase ? ` &middot; ${escapeHtml(site.constructionPhase)}` : ''}</p>
</body>
</html>`);
  }
}
```

- [ ] **Step 2: Register the controller**

Modify `src/sites/sites.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MailModule } from '../mail/mail.module';
import { PublicSitesController } from './public-sites.controller';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

@Module({
  imports: [AuditLogModule, MailModule],
  controllers: [SitesController, PublicSitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
```

- [ ] **Step 3: Build**

```bash
pnpm run build
```

- [ ] **Step 4: Manually verify**

```bash
pnpm run start:dev
```

```bash
# Grab any existing site id, e.g. from GET /sites with a valid token, or reuse one from earlier verification.
curl -s http://localhost:5000/public/sites/<a-real-site-id> | head -c 2000
echo "---404 case---"
curl -s -w "\nHTTP %{http_code}\n" http://localhost:5000/public/sites/00000000-0000-0000-0000-000000000000
```

Expected: the first call returns HTML containing `og:title`/`og:description`/`og:image` with the real site's name/address, and an `<img src="https://api.mapbox.com/...">` tag using the real `MAPBOX_TOKEN`. The second returns `404` with the plain "Site not found" HTML. Also confirm no `contractorId`/personnel/approvals data appears anywhere in the response.

- [ ] **Step 5: Commit**

```bash
git add src/sites/public-sites.controller.ts src/sites/sites.module.ts
git commit -m "feat: add public, server-rendered site share page with Open Graph tags"
```

---

### Task 4: Frontend — `mapbox-gl` + `getMapPins` query

**Files:**
- Modify: `package.json`
- Modify: `src/store/api/sitesApi.ts`

**Interfaces:**
- Consumes: `GET /sites/map` (Task 1).
- Produces: `MapPin` type, `useGetMapPinsQuery`. Task 5 consumes both.

- [ ] **Step 1: Install dependencies**

```bash
npm install mapbox-gl react-map-gl
npm install -D @types/mapbox-gl
```

- [ ] **Step 2: Add the type and query to `sitesApi.ts`**

Modify `src/store/api/sitesApi.ts` — add near the other type exports:

```typescript
export interface MapPin {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  status: string;
  address: string;
  constructionPhase: string | null;
}
```

Inside `injectEndpoints`'s `endpoints:` object, after `getSites`:

```typescript
    getMapPins: builder.query<MapPin[], void>({
      query: () => '/sites/map',
      providesTags: [{ type: 'Site' as const, id: 'LIST' }],
    }),
```

Add to the export block:

```typescript
export const {
  useGetSitesQuery,
  useGetSiteQuery,
  useGetMapPinsQuery,
  useCreateSiteMutation,
  useUpdateSiteMutation,
  useDeleteSiteMutation,
} = sitesApi;
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/store/api/sitesApi.ts
git commit -m "feat: add mapbox-gl/react-map-gl and a getMapPins query"
```

---

### Task 5: Frontend — `SitesMap.tsx` page + nav entry

**Files:**
- Create: `src/pages/SitesMap.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/layout/DesktopSidebar.tsx`

**Interfaces:**
- Consumes: `useGetMapPinsQuery` (Task 4), `VITE_MAPBOX_TOKEN` (env, already set).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Write `SitesMap.tsx`**

`src/pages/SitesMap.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import Map, { Marker, Popup } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useGetMapPinsQuery, type MapPin } from '@/store/api/sitesApi';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

export default function SitesMap() {
  const { data: pins = [], isLoading } = useGetMapPinsQuery();
  const [selected, setSelected] = useState<MapPin | null>(null);

  const center = pins.length
    ? { latitude: pins[0].latitude, longitude: pins[0].longitude }
    : { latitude: -1.286389, longitude: 36.817223 }; // Nairobi fallback when there are no pins yet

  return (
    <AppLayout>
      <PageHeader title="Sites Map" subtitle={`${pins.length} sites`} />
      <div className="p-4 animate-fade-in">
        {isLoading ? (
          <div className="h-[70vh] bg-muted rounded-xl animate-pulse" />
        ) : (
          <div className="h-[70vh] rounded-xl overflow-hidden border">
            <Map
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={{ ...center, zoom: 11 }}
              mapStyle="mapbox://styles/mapbox/streets-v11"
            >
              {pins.map((pin) => (
                <Marker
                  key={pin.id}
                  latitude={pin.latitude}
                  longitude={pin.longitude}
                  color="#ef4444"
                  onClick={(e) => {
                    e.originalEvent.stopPropagation();
                    setSelected(pin);
                  }}
                />
              ))}

              {selected && (
                <Popup
                  latitude={selected.latitude}
                  longitude={selected.longitude}
                  onClose={() => setSelected(null)}
                  closeOnClick={false}
                  anchor="bottom"
                >
                  <div className="space-y-1 p-1 max-w-[220px]">
                    <p className="font-semibold text-sm">{selected.name}</p>
                    <p className="text-xs text-muted-foreground">{selected.address}</p>
                    <div className="flex items-center gap-1">
                      <Badge variant={selected.status === 'active' ? 'default' : 'secondary'} className="text-[10px]">
                        {selected.status}
                      </Badge>
                      {selected.constructionPhase && (
                        <Badge variant="outline" className="text-[10px]">
                          {selected.constructionPhase}
                        </Badge>
                      )}
                    </div>
                    <Button asChild size="sm" className="w-full mt-1">
                      <Link to={`/sites/${selected.id}`}>View details</Link>
                    </Button>
                  </div>
                </Popup>
              )}
            </Map>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Add the route**

Modify `src/App.tsx`:

```typescript
import SitesMap from "./pages/SitesMap";
```

```typescript
        <Route
          path="/sites-map"
          element={
            <ProtectedRoute>
              <SitesMap />
            </ProtectedRoute>
          }
        />
```

(placed alongside the `/sites` route)

- [ ] **Step 3: Add the sidebar nav entry**

Modify `src/components/layout/DesktopSidebar.tsx` — add the `Map` icon import and a new entry right after "Sites":

```typescript
import {
  LayoutDashboard,
  MapPin,
  Map as MapIcon,
  ClipboardCheck,
  FileText,
  ChevronLeft,
  ChevronRight,
  Users,
  Shield
} from 'lucide-react';
```

```typescript
const mainNavItems: NavItem[] = [
  { icon: LayoutDashboard, label: 'Dashboard', href: '/' },
  { icon: MapPin, label: 'Sites', href: '/sites' },
  { icon: MapIcon, label: 'Sites Map', href: '/sites-map' },
  { icon: ClipboardCheck, label: 'Inspections', href: '/inspections' },
  { icon: FileText, label: 'Reports', href: '/reports' },
];
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 5: Manually verify**

Start both dev servers, log in, open the new "Sites Map" nav entry, confirm pins render at the correct locations, clicking one opens the popup with correct data, and "View details" navigates to `/sites/:id`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/SitesMap.tsx src/App.tsx src/components/layout/DesktopSidebar.tsx
git commit -m "feat: add sites map page with pin popups"
```

---

### Task 6: Frontend — Share button on `SiteDetail.tsx`

**Files:**
- Modify: `src/pages/SiteDetail.tsx`

**Interfaces:**
- Consumes: nothing new — builds the public URL directly from `import.meta.env.VITE_API_URL`.
- Produces: nothing consumed elsewhere — last task.

- [ ] **Step 1: Add the Share import and handler**

Modify `src/pages/SiteDetail.tsx`:

```typescript
import { MapPin, Building2, Calendar, Navigation, Edit, Trash2, Mail, Share2 } from 'lucide-react';
```

Add the handler, alongside `handleResend`:

```typescript
  const handleShare = async () => {
    if (!currentSite) return;
    const url = `${import.meta.env.VITE_API_URL}/public/sites/${currentSite.id}`;

    if (navigator.share) {
      try {
        await navigator.share({ title: currentSite.name, url });
      } catch {
        // User cancelled the native share sheet — not an error.
      }
      return;
    }

    await navigator.clipboard.writeText(url);
    toast({ title: 'Link copied', description: 'The public site link has been copied to your clipboard.' });
  };
```

- [ ] **Step 2: Render the button**

Add it into the "Actions" row, before the Request Inspection button:

```tsx
        <div className="flex justify-end gap-3 sm:gap-6">
          <Button variant="outline" size="icon" onClick={handleShare}>
            <Share2 className="h-4 w-4" />
          </Button>
          {hasPermission(roles, 'create_inspection_requests') && (
            <Button className="w-1/2 sm:w-1/6" onClick={() => setIsRequestOpen(true)}>
              Request Inspection
            </Button>
          )}
        </div>
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit --project tsconfig.app.json
```

- [ ] **Step 4: Manually verify**

On a browser/device with the Web Share API (most mobile browsers, some desktop Chromium builds), confirm clicking Share opens the native share sheet with the correct URL. On a browser without it (e.g. desktop Firefox), confirm it copies the link and shows the toast. Paste the copied URL into a new tab and confirm it loads the public HTML page from Task 3 (not a 404, not the SPA).

- [ ] **Step 5: Commit**

```bash
git add src/pages/SiteDetail.tsx
git commit -m "feat: add Share button linking to the public site page"
```

---

## Self-Review Notes

- **Spec coverage:** §1 map pin endpoint — Task 1. §2 public share page (including the CSP fix it depends on, and the 404 HTML case) — Tasks 2–3. §3 `/sites-map` page — Tasks 4–5. §4 Share button — Task 6.
- **Placeholder scan:** no TBDs. Fixed a real typo caught during self-review: Task 4 Step 2 originally had a stray "typescter" code-fence language tag — corrected to "typescript".
- **Type consistency:** `MapPin` (Task 1, backend) and `MapPin` (Task 4, frontend) have identical field names/types — the frontend type is a direct, unmapped passthrough of the backend response (no snake_case conversion needed, since this is a purpose-built endpoint rather than reusing the `Site`/`mapSite` convention). `useGetMapPinsQuery` (Task 4's export) is the exact hook name Task 5 imports.
