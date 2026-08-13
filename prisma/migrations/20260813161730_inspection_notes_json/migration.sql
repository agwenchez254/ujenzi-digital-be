/*
  Warnings:

  - You are about to drop the column `checklistResponses` on the `Inspection` table. All the data in the column will be lost.
  - You are about to drop the column `observations` on the `Inspection` table. All the data in the column will be lost.
  - You are about to drop the column `recommendations` on the `Inspection` table. All the data in the column will be lost.
  - The `notes` column on the `Inspection` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "Inspection" DROP COLUMN "checklistResponses",
DROP COLUMN "observations",
DROP COLUMN "recommendations",
DROP COLUMN "notes",
ADD COLUMN     "notes" JSONB;
