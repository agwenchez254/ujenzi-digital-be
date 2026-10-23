ALTER TABLE "ChatMessage"
  ADD COLUMN "encrypted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ciphertext" TEXT,
  ADD COLUMN "iv" TEXT,
  ADD COLUMN "keyEpoch" INTEGER,
  ADD COLUMN "senderDeviceId" TEXT,
  ADD COLUMN "signature" TEXT;

CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "encryptionKey" TEXT NOT NULL,
    "signingKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KeyBackup" (
    "userId" TEXT NOT NULL,
    "blob" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "kdf" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyBackup_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "ChatKeyEpoch" (
    "id" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "createdByDeviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatKeyEpoch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatKeyWrap" (
    "id" TEXT NOT NULL,
    "epochId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "ephemeralKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,

    CONSTRAINT "ChatKeyWrap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserDevice_userId_encryptionKey_key" ON "UserDevice"("userId", "encryptionKey");
CREATE INDEX "UserDevice_userId_idx" ON "UserDevice"("userId");
CREATE UNIQUE INDEX "ChatKeyEpoch_channelKey_epoch_key" ON "ChatKeyEpoch"("channelKey", "epoch");
CREATE UNIQUE INDEX "ChatKeyWrap_epochId_deviceId_key" ON "ChatKeyWrap"("epochId", "deviceId");
CREATE INDEX "ChatKeyWrap_deviceId_idx" ON "ChatKeyWrap"("deviceId");

ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KeyBackup" ADD CONSTRAINT "KeyBackup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatKeyWrap" ADD CONSTRAINT "ChatKeyWrap_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "ChatKeyEpoch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatKeyWrap" ADD CONSTRAINT "ChatKeyWrap_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "UserDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
