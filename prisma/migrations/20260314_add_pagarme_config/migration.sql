-- CreateTable
CREATE TABLE "pagarme_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT,
    "privateKey" TEXT,
    "webhookUrl" TEXT,
    "splitReceiverId" TEXT,
    "splitRate" TEXT DEFAULT '3.67',
    "splitAnticipationRate" TEXT,
    "credentialsLocked" BOOLEAN NOT NULL DEFAULT false,
    "splitLocked" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pagarme_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pagarme_configs_userId_key" ON "pagarme_configs"("userId");

-- CreateIndex
CREATE INDEX "pagarme_configs_userId_idx" ON "pagarme_configs"("userId");
