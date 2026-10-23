ALTER TABLE "ChatMessage" ADD COLUMN "clientId" TEXT;
CREATE UNIQUE INDEX "ChatMessage_authorId_clientId_key" ON "ChatMessage"("authorId", "clientId");

ALTER TABLE "ChatDelivery" ADD COLUMN "readUntil" TIMESTAMP(3);
