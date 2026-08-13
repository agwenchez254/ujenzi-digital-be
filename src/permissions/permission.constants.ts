export const PERMISSION_CATALOG = [
  'view_sites',
  'create_sites',
  'edit_sites',
  'delete_sites',
  'view_inspections',
  'create_inspection_requests',
  'accept_inspection_requests',
  'perform_inspections',
  'view_reports',
  'create_reports',
  'manage_users',
  'manage_templates',
  'view_audit_logs',
] as const;

export type Permission = (typeof PERMISSION_CATALOG)[number];
