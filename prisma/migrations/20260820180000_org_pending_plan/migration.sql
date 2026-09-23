-- O plano da organização passa a mudar quando o cliente muda de plano.
--
-- `organization_subscriptions.plan_id` era escrito uma única vez, no
-- provisionamento. Toda guarda de plano lê dali — contas de anúncios, ações,
-- plataformas, IA, relatórios, anúncios analisados, assentos. Trocar de plano
-- mexia apenas em `subscriptions` (escopo de conta), então:
--
--   • quem subia para o Profissional continuava com os limites do Individual;
--   • quem descia continuava com os do Profissional, indefinidamente.
--
-- O segundo é custo sem receita, e um convite a assinar o plano caro, baixar e
-- manter tudo. O primeiro é entrega sem cobrança. Os dois somem com a coluna
-- abaixo, resolvida por leitura.
ALTER TABLE "organization_subscriptions"
  ADD COLUMN "pending_plan_id" TEXT,
  ADD COLUMN "pending_plan_effective_at" TIMESTAMP(3);

ALTER TABLE "organization_subscriptions"
  ADD CONSTRAINT "organization_subscriptions_pending_plan_id_fkey"
  FOREIGN KEY ("pending_plan_id") REFERENCES "plans"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "organization_subscriptions_pending_plan_effective_at_idx"
  ON "organization_subscriptions"("pending_plan_effective_at");
