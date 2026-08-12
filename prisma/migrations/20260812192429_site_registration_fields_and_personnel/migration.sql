CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "DevelopmentType" AS ENUM ('RESIDENTIAL', 'COMMERCIAL', 'INDUSTRIAL', 'MIXED_USE', 'INSTITUTIONAL');

-- CreateEnum
CREATE TYPE "SitePersonnelRole" AS ENUM ('DEVELOPER', 'SITE_REPRESENTATIVE', 'CONTRACTOR', 'QUANTITY_SURVEYOR', 'ENGINEER');

-- AlterEnum
ALTER TYPE "AppRole" ADD VALUE 'developer';

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "approvals" JSONB,
ADD COLUMN     "constituency" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "county" TEXT,
ADD COLUMN     "developmentType" "DevelopmentType",
ADD COLUMN     "landmarks" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "location" geography(Point,4326),
ADD COLUMN     "plotNumber" TEXT,
ADD COLUMN     "town" TEXT,
ALTER COLUMN "geofenceRadius" SET DEFAULT 500;

-- CreateTable
CREATE TABLE "SitePersonnel" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "role" "SitePersonnelRole" NOT NULL,
    "userId" TEXT,
    "name" TEXT,
    "contact" TEXT,

    CONSTRAINT "SitePersonnel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SitePersonnel_siteId_idx" ON "SitePersonnel"("siteId");

-- CreateIndex
CREATE INDEX "SitePersonnel_userId_idx" ON "SitePersonnel"("userId");

-- AddForeignKey
ALTER TABLE "SitePersonnel" ADD CONSTRAINT "SitePersonnel_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePersonnel" ADD CONSTRAINT "SitePersonnel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Keep Site.location in sync with latitude/longitude automatically.
CREATE OR REPLACE FUNCTION sync_site_location() RETURNS trigger AS $$
BEGIN
  NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude::float8, NEW.latitude::float8), 4326)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER site_location_sync
  BEFORE INSERT OR UPDATE OF latitude, longitude ON "Site"
  FOR EACH ROW EXECUTE FUNCTION sync_site_location();

-- Backfill location for every existing row (no-op update fires the trigger above).
UPDATE "Site" SET latitude = latitude;

-- Backfill the new default radius onto every existing site too (explicit product decision,
-- not just new sites going forward).
UPDATE "Site" SET "geofenceRadius" = 500;
