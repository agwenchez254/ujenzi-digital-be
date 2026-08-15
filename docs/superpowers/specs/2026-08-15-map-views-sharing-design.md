# Map Views & Sharing design

Date: 2026-08-15

## Purpose

Spec 5 of the original 6-spec sequence. Site locations are already stored in
PostGIS (`Site.location`, kept in sync with `latitude`/`longitude` by a
Postgres trigger since Spec 1) but never surfaced visually. This spec adds:
an all-sites map for administrators (scoped to tied sites for everyone
else), and a public, shareable read-only preview page per site that renders
correctly as a link-preview card on social platforms (WhatsApp, Twitter,
Facebook), which a plain React SPA route cannot do.

## 1. Backend: map pin endpoint

`GET /sites/map` (any authenticated user). Administrators receive every
site; everyone else receives only sites they're tied to, reusing
`SitesService.resolveTiedSiteIds` (already built for Spec 3's read-access
broadening). Returns a lightweight, purpose-built shape — not the full
`findSiteOrThrow` payload:

```typescript
interface MapPin {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  status: string;
  address: string;
  constructionPhase: string | null;
}
```

No contractor, personnel, or approvals data — this endpoint exists solely
to render pins and a small popup, and there's no reason to ship more than
that to the client.

## 2. Backend: public share page

`GET /public/sites/:id`, decorated `@Public()`. Unlike every other route in
this API, this one renders plain HTML directly via Nest's `@Res()` — not
JSON, and not a redirect into the React SPA. This is a deliberate deviation
from how the rest of the app works, and it's deliberate for a specific
reason: social-media link-preview crawlers (WhatsApp, Twitter, Facebook)
fetch a URL's raw HTML and do not execute JavaScript, so a client-rendered
SPA route can never produce per-site Open Graph tags — the crawler would
only ever see the one static `index.html`, regardless of which site was
shared. Rendering the page server-side is the only way to get a real,
per-site preview card.

The HTML includes:

- `<meta property="og:title">` — the site name
- `<meta property="og:description">` — address + status
- `<meta property="og:image">` — a static map image via Mapbox's Static
  Images API (`https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/pin-s+f00(lng,lat)/lng,lat,14/600x315?access_token=...`),
  using the `MAPBOX_TOKEN` env var. This is an `<img>` src, not a script —
  no client-side map library runs on this page at all.
- A minimal human-readable body (name, address, status, the same static map
  image) — this same page is what a real visitor sees too; there's no
  separate "real" experience to redirect to. Bot-sniffing by User-Agent to
  serve two different pages was considered and rejected as unnecessary
  complexity for what's fundamentally a read-only preview.

Exposed fields are deliberately minimal: name, address, status,
construction phase, and the map pin. Never contractor, personnel,
approvals, or plot/legal identifiers — this route requires no
authentication, so anything included here is available to anyone who has
the link, indefinitely.

A nonexistent site id returns a plain 404 HTML page (a short "Site not
found" message), not a JSON error — this route bypasses the global
`HttpExceptionFilter` entirely (it renders directly via `@Res()`), so it
needs its own explicit not-found HTML rather than inheriting the JSON error
shape the rest of the API uses.

`MAPBOX_TOKEN` is a Mapbox **public** token (`pk.`-prefixed) — Mapbox's own
convention for tokens meant to appear in client-visible contexts (URLs,
frontend bundles), typically scoped via URL/referrer restrictions in the
Mapbox account dashboard rather than being kept secret. Using it directly
in an `<img>` src here, and in the frontend's map page (§3), is the
intended usage pattern, not a leak.

## 3. Frontend: `/sites-map` page

New page, linked from the sidebar alongside the existing Sites list (same
`view_sites` permission gate — no new permission needed, since this is just
an alternate view of data the user could already list). Renders pins via
`mapbox-gl` + `react-map-gl`, using `VITE_MAPBOX_TOKEN` (same public-token
reasoning as above — safe to ship in the client bundle) against the new
`GET /sites/map` endpoint.

Clicking a pin opens a small popup showing name, address, status, and
construction phase, with a "View details" link into the existing,
authenticated `/sites/:id` page — the map page itself is just a different
way to reach the same detail page, not a new data-exposure surface.

## 4. Frontend: Share button

`SiteDetail.tsx` gains a "Share" button. On click: `navigator.share()` (Web
Share API) if available — this hands off to the OS's native share sheet,
where the user picks WhatsApp/Twitter/whatever themselves, no
platform-specific share-intent code needed — falling back to copying the
link to the clipboard (with a toast confirmation) on browsers/contexts
without `navigator.share` (e.g. desktop Firefox). The shared URL is the
**backend's** public route (`${VITE_API_URL}/public/sites/:id}`), not a
frontend route — that page doesn't exist in the SPA at all, per §2.

## 5. Testing

No automated tests, consistent with the rest of the project. Backend:
curl-based checks that `/sites/map` returns all sites for an administrator
and only tied sites for a contractor/developer, and that `/public/sites/:id`
returns real HTML (not JSON) with the expected `og:` meta tags and no
sensitive fields, for both a valid and a nonexistent site id. Frontend:
browser verification that the map page renders pins, popups link through
correctly, and the Share button either opens a native share sheet or
copies the link, depending on the browser.
