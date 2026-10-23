import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  SITE_DOCUMENT_KINDS,
  SITE_DOCUMENT_MAX_BYTES,
  SITE_DOCUMENT_TYPES,
  SiteDocumentKind,
  SiteDocumentView,
} from './site-documents.types';
import { SitesService } from './sites.service';

const NAMESPACE = 'site-documents';
const VIEW_SELECT = {
  id: true,
  siteId: true,
  kind: true,
  fileName: true,
  mimeType: true,
  size: true,
  createdAt: true,
} as const;

/** Display name only: strips any path, control characters and over-long names. */
function cleanFileName(original: string): string {
  const base = path.basename(original.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const safe = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return (safe || 'document').slice(0, 120);
}

type ViewRow = {
  id: string;
  siteId: string;
  kind: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: Date;
};

function toView(row: ViewRow): SiteDocumentView {
  return { ...row, kind: row.kind as SiteDocumentKind, createdAt: row.createdAt.toISOString() };
}

@Injectable()
export class SiteDocumentsService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private sitesService: SitesService,
    private auditLogService: AuditLogService,
  ) {}

  /** Approvals are sensitive: only administrators, engineers and people on the project can see them. */
  private async assertCanView(siteId: string, user: AuthenticatedUser) {
    if (user.roles.includes('administrator') || user.roles.includes('engineer')) return;
    if (!(await this.sitesService.isTiedToSite(siteId, user.userId))) {
      throw new ForbiddenException('You are not part of this project');
    }
  }

  /** Same rule as editing the site: its contractor, a linked developer, or an administrator. */
  private async assertCanManage(siteId: string, user: AuthenticatedUser) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { id: true, contractorId: true } });
    if (!site) throw new NotFoundException('Site not found');
    if (site.contractorId === user.userId || user.roles.includes('administrator')) return;
    const linkedDeveloper = await this.prisma.sitePersonnel.findFirst({
      where: { siteId, userId: user.userId, role: 'DEVELOPER' },
    });
    if (!linkedDeveloper) throw new ForbiddenException('You do not own this site');
  }

  async list(siteId: string, user: AuthenticatedUser): Promise<SiteDocumentView[]> {
    await this.assertCanView(siteId, user);
    const rows = await this.prisma.siteDocument.findMany({
      where: { siteId },
      select: VIEW_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  /** Saves (or replaces) the document of one kind for a site. */
  async upload(siteId: string, kind: string, file: Express.Multer.File | undefined, user: AuthenticatedUser, ip?: string) {
    if (!(SITE_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`kind must be one of ${SITE_DOCUMENT_KINDS.join(', ')}`);
    }
    if (!file) throw new BadRequestException('Attach a file');
    if (!SITE_DOCUMENT_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Use a PDF, image (JPG, PNG, WebP), Word or ZIP file');
    }
    if (file.size > SITE_DOCUMENT_MAX_BYTES) {
      throw new BadRequestException(`The file is larger than ${SITE_DOCUMENT_MAX_BYTES / 1024 / 1024} MB`);
    }
    await this.assertCanManage(siteId, user);

    const storageKey = await this.storage.save(
      file.buffer,
      NAMESPACE,
      `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`,
    );
    const previous = await this.prisma.siteDocument.findUnique({ where: { siteId_kind: { siteId, kind } } });
    const data = {
      fileName: cleanFileName(file.originalname),
      mimeType: file.mimetype,
      size: file.size,
      storageKey,
      uploadedById: user.userId,
    };
    let row: ViewRow;
    try {
      row = await this.prisma.siteDocument.upsert({
        where: { siteId_kind: { siteId, kind } },
        create: { siteId, kind, ...data },
        update: data,
        select: VIEW_SELECT,
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
    if (previous) await this.storage.delete(previous.storageKey).catch(() => undefined);

    await this.auditLogService.log(user.userId, 'site.document_uploaded', 'Site', siteId, { kind }, ip);
    return toView(row);
  }

  async remove(docId: string, user: AuthenticatedUser, ip?: string) {
    const doc = await this.prisma.siteDocument.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Document not found');
    await this.assertCanManage(doc.siteId, user);
    await this.prisma.siteDocument.delete({ where: { id: docId } });
    await this.storage.delete(doc.storageKey).catch(() => undefined);
    await this.auditLogService.log(user.userId, 'site.document_removed', 'Site', doc.siteId, { kind: doc.kind }, ip);
    return { success: true };
  }

  async getFile(docId: string, user: AuthenticatedUser) {
    const doc = await this.prisma.siteDocument.findUnique({ where: { id: docId } });
    if (!doc) throw new NotFoundException('Document not found');
    await this.assertCanView(doc.siteId, user);
    return {
      stream: this.storage.read(doc.storageKey),
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      size: doc.size,
    };
  }
}
