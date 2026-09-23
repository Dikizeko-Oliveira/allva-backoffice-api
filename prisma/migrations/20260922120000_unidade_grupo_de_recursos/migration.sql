-- D23: o grupo de recursos do Performance Max entra na análise como unidade.
-- Aditiva: todo anúncio existente é um anúncio (`AD`), e nada é reescrito.

-- CreateEnum
CREATE TYPE "AdUnitKind" AS ENUM ('AD', 'ASSET_GROUP');

-- AlterTable
ALTER TABLE "ads" ADD COLUMN "unit_kind" "AdUnitKind" NOT NULL DEFAULT 'AD';
