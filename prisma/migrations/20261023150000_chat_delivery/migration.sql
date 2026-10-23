CREATE TABLE "ChatDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "deliveredUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatDelivery_userId_channelKey_key" ON "ChatDelivery"("userId", "channelKey");

ALTER TABLE "ChatDelivery" ADD CONSTRAINT "ChatDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
