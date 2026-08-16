-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerificationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "emailVerificationTokenHash" TEXT,
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT true;

-- Every row created from this point forward should start unverified; only
-- the backfill above (for rows that already existed) should default to true.
ALTER TABLE "User" ALTER COLUMN "emailVerified" SET DEFAULT false;
