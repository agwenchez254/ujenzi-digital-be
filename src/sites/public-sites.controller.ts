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
