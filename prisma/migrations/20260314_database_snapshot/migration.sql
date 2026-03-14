-- CreateTable
CREATE TABLE "database_snapshots" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_snapshots_pkey" PRIMARY KEY ("id")
);
