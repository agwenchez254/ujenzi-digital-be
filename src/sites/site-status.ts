export const SITE_STATUSES = ['active', 'inactive', 'paused', 'completed'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];
