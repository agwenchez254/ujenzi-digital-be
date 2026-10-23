-- Postgres does not index foreign keys automatically; these back the hot lookups.
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
CREATE INDEX "RefreshToken_tokenHash_idx" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
CREATE INDEX "InspectionRequest_siteId_status_idx" ON "InspectionRequest"("siteId", "status");
CREATE INDEX "InspectionRequest_contractorId_idx" ON "InspectionRequest"("contractorId");
CREATE INDEX "InspectionRequest_engineerId_status_idx" ON "InspectionRequest"("engineerId", "status");
CREATE INDEX "Inspection_requestId_idx" ON "Inspection"("requestId");
CREATE INDEX "Inspection_siteId_createdAt_idx" ON "Inspection"("siteId", "createdAt");
CREATE INDEX "Inspection_engineerId_status_idx" ON "Inspection"("engineerId", "status");
CREATE INDEX "Media_inspectionId_idx" ON "Media"("inspectionId");
CREATE INDEX "Report_inspectionId_idx" ON "Report"("inspectionId");
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
