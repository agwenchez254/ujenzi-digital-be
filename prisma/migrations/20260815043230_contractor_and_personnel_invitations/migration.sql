/*
  Warnings:

  - Added the required column `invitedEmail` to the `ContractorInvitation` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ContractorInvitation" DROP CONSTRAINT "ContractorInvitation_invitedUserId_fkey";

-- AlterTable
ALTER TABLE "ContractorInvitation" ADD COLUMN     "invitedEmail" TEXT,
ALTER COLUMN "invitedUserId" DROP NOT NULL;

-- Backfill invitedEmail from the already-linked user for existing rows.
UPDATE "ContractorInvitation" ci
SET "invitedEmail" = u."email"
FROM "User" u
WHERE ci."invitedUserId" = u."id";

ALTER TABLE "ContractorInvitation" ALTER COLUMN "invitedEmail" SET NOT NULL;

-- AlterTable
ALTER TABLE "SitePersonnel" ADD COLUMN     "email" TEXT,
ADD COLUMN     "invitationAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "invitationExpiresAt" TIMESTAMP(3),
ADD COLUMN     "invitationTokenHash" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailChangeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "emailChangeTokenHash" TEXT,
ADD COLUMN     "pendingEmail" TEXT;

-- AddForeignKey
ALTER TABLE "ContractorInvitation" ADD CONSTRAINT "ContractorInvitation_invitedUserId_fkey" FOREIGN KEY ("invitedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
