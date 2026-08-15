import { Controller, Get, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'crypto';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

const MAPBOX_GL_VERSION = '3.28.1';
// Computed from the actual files served at these URLs — verify against a
// fresh download before bumping MAPBOX_GL_VERSION.
const MAPBOX_GL_JS_INTEGRITY = 'sha384-VOlmgh0/P4/iMFp93KgZ/dslg/arHDGRH9AOmgy3r7hhSMWFPq6kJQuP1eV0Yf8v';
const MAPBOX_GL_CSS_INTEGRITY = 'sha384-XUbQaovfoSbaMso2Q1a1bLMGwU+1h7twi9V0vkuM6eOCZd0i52f6iAuxtHaP1nDO';

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
    const site = await this.prisma.site.findFirst({
      where: { id, isPubliclyShared: true },
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
    // Crawlers (WhatsApp/Twitter/Facebook) fetch this page's raw HTML and never
    // execute JavaScript, so og:image must stay a plain static image — this is
    // the only thing they'll ever see. Real visitors get the interactive map
    // rendered further down instead.
    const mapImageUrl =
      `https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/` +
      `pin-s+f00(${lon},${lat})/${lon},${lat},14/600x315?access_token=${mapboxToken}`;
    const pageUrl = `${this.configService.get<string>('FRONTEND_ORIGIN')}/public/sites/${id}`;

    // Scoped to just this response — the rest of the API stays on the
    // stricter global CSP set in main.ts. Mapbox GL needs script/connect
    // access to its own domain and blob: workers for tile parsing; the nonce
    // allows only this specific inline script to run, not arbitrary inline JS.
    const nonce = randomBytes(16).toString('base64');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'self' https://api.mapbox.com 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline' https://api.mapbox.com",
        "img-src 'self' data: https://api.mapbox.com https://*.tiles.mapbox.com",
        "connect-src 'self' https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com",
        "worker-src blob:",
        "child-src blob:",
      ].join('; '),
    );

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
  <link
    href="https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_GL_VERSION}/mapbox-gl.css"
    rel="stylesheet"
    integrity="${MAPBOX_GL_CSS_INTEGRITY}"
    crossorigin="anonymous"
  />
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
    #map { width: 100%; height: 300px; border-radius: 8px; }
    h1 { font-size: 1.5rem; }
    .status { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #eee; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div id="map"></div>
  <h1>${name}</h1>
  <p>${address}</p>
  <p><span class="status">${status}</span>${site.constructionPhase ? ` &middot; ${escapeHtml(site.constructionPhase)}` : ''}</p>
  <script
    src="https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_GL_VERSION}/mapbox-gl.js"
    integrity="${MAPBOX_GL_JS_INTEGRITY}"
    crossorigin="anonymous"
  ></script>
  <script nonce="${nonce}">
    mapboxgl.accessToken = ${JSON.stringify(mapboxToken)};
    var map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/streets-v11',
      center: [${lon}, ${lat}],
      zoom: 14,
    });
    map.addControl(new mapboxgl.NavigationControl());
    new mapboxgl.Marker({ color: '#ef4444' }).setLngLat([${lon}, ${lat}]).addTo(map);
  </script>
</body>
</html>`);
  }
}
