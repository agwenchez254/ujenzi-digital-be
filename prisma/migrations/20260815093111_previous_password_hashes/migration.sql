-- AlterTable
ALTER TABLE "User" ADD COLUMN     "previousPasswordHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
