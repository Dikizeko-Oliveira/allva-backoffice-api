-- Congelamento de conta de anúncios por limite de plano.
--
-- Um cliente com 10 contas que contrata o Individual (2) não pode ter 8 contas
-- apagadas: ele pagou por elas e pode voltar. Também não pode ficar com as 10
-- ativas, senão o teto do plano é decorativo.
--
-- `frozen_at` no futuro é agendamento — o downgrade só vale no fim do período
-- pago, e até lá nada muda. A leitura compara com `now()`, então o congelamento
-- não depende do webhook da Stripe chegar.
ALTER TABLE "ad_accounts" ADD COLUMN "frozen_at" TIMESTAMP(3);

CREATE INDEX "ad_accounts_organization_id_frozen_at_idx"
  ON "ad_accounts"("organization_id", "frozen_at");
