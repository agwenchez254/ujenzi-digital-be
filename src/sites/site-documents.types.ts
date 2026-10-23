export const SITE_DOCUMENT_KINDS = ['COUNTY_APPROVAL', 'NEMA_APPROVAL', 'NCA_APPROVAL', 'BUILDING_PLAN'] as const;
export type SiteDocumentKind = (typeof SITE_DOCUMENT_KINDS)[number];

export const SITE_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Scans and photos of certificates, PDFs and Word files. */
export const SITE_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
]);

export interface SiteDocumentView {
  id: string;
  siteId: string;
  kind: SiteDocumentKind;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}
