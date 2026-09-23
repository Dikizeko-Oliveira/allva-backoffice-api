-- Tetos negociados por contrato (Enterprise).
--
-- "Ilimitado" era desconto, nao entrega: a entrega escalava com o uso e a
-- receita nao, e o custo marginal (LLM, cota de API, storage) ficava sem teto do
-- nosso lado. O catalogo passa a publicar um piso, e o numero de cada contrato
-- mora aqui.
--
-- NULL = herda o plano. Nunca "ilimitado" — ilimitado deixou de existir.
CREATE TABLE "organization_quotas" (
    "organization_id" TEXT NOT NULL,
    "max_ad_accounts" INTEGER,
    "max_monitored_ads" INTEGER,
    "max_seats" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_quotas_pkey" PRIMARY KEY ("organization_id")
);

ALTER TABLE "organization_quotas"
  ADD CONSTRAINT "organization_quotas_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
