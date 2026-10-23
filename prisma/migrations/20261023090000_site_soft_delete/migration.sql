-- AlterTable
ALTER TABLE "Site" ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deletedById" TEXT;

-- CreateIndex
CREATE INDEX "Site_deletedAt_idx" ON "Site"("deletedAt");
