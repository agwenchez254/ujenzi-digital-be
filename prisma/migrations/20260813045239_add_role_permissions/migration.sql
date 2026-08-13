-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "role" "AppRole" NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_role_permission_key" ON "RolePermission"("role", "permission");

-- Seed with today's hardcoded FE map (sitesight-pro's usePermissions.ts) so
-- cutover doesn't change anyone's visible capabilities.
INSERT INTO "RolePermission" (id, role, permission) VALUES
  (gen_random_uuid(), 'administrator', 'view_sites'),
  (gen_random_uuid(), 'administrator', 'create_sites'),
  (gen_random_uuid(), 'administrator', 'edit_sites'),
  (gen_random_uuid(), 'administrator', 'delete_sites'),
  (gen_random_uuid(), 'administrator', 'view_inspections'),
  (gen_random_uuid(), 'administrator', 'create_inspection_requests'),
  (gen_random_uuid(), 'administrator', 'accept_inspection_requests'),
  (gen_random_uuid(), 'administrator', 'perform_inspections'),
  (gen_random_uuid(), 'administrator', 'view_reports'),
  (gen_random_uuid(), 'administrator', 'create_reports'),
  (gen_random_uuid(), 'administrator', 'manage_users'),
  (gen_random_uuid(), 'administrator', 'manage_templates'),
  (gen_random_uuid(), 'administrator', 'view_audit_logs'),
  (gen_random_uuid(), 'developer', 'view_sites'),
  (gen_random_uuid(), 'developer', 'create_sites'),
  (gen_random_uuid(), 'developer', 'edit_sites'),
  (gen_random_uuid(), 'developer', 'delete_sites'),
  (gen_random_uuid(), 'developer', 'view_inspections'),
  (gen_random_uuid(), 'developer', 'create_inspection_requests'),
  (gen_random_uuid(), 'developer', 'accept_inspection_requests'),
  (gen_random_uuid(), 'developer', 'perform_inspections'),
  (gen_random_uuid(), 'developer', 'view_reports'),
  (gen_random_uuid(), 'developer', 'create_reports'),
  (gen_random_uuid(), 'developer', 'manage_users'),
  (gen_random_uuid(), 'developer', 'manage_templates'),
  (gen_random_uuid(), 'developer', 'view_audit_logs'),
  (gen_random_uuid(), 'engineer', 'view_sites'),
  (gen_random_uuid(), 'engineer', 'view_inspections'),
  (gen_random_uuid(), 'engineer', 'accept_inspection_requests'),
  (gen_random_uuid(), 'engineer', 'perform_inspections'),
  (gen_random_uuid(), 'engineer', 'view_reports'),
  (gen_random_uuid(), 'engineer', 'create_reports'),
  (gen_random_uuid(), 'contractor', 'view_sites'),
  (gen_random_uuid(), 'contractor', 'create_sites'),
  (gen_random_uuid(), 'contractor', 'edit_sites'),
  (gen_random_uuid(), 'contractor', 'delete_sites'),
  (gen_random_uuid(), 'contractor', 'view_inspections'),
  (gen_random_uuid(), 'contractor', 'create_inspection_requests'),
  (gen_random_uuid(), 'contractor', 'view_reports'),
  (gen_random_uuid(), 'site_representative', 'view_sites'),
  (gen_random_uuid(), 'site_representative', 'view_inspections'),
  (gen_random_uuid(), 'site_representative', 'view_reports');
