-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stationId" TEXT;

-- CreateTable
CREATE TABLE "WaterStation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaterStation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaterStation_isActive_idx" ON "WaterStation"("isActive");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "WaterStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
