-- O teto de anúncios analisados, materializado.
--
-- O limite do plano não é uma parede: recusar o ingest acima de N perderia dado
-- e faria o total de desperdício da organização ser calculado sobre uma leitura
-- incompleta — um número errado, que é pior que um número declaradamente parcial.
--
-- O que o plano governa é quantos anúncios entram na **análise** da noite. A
-- seleção roda uma vez por organização, ordena por gasto na janela e carimba os
-- escolhidos. Materializar em vez de cada motor rodar o próprio ranking é o que
-- garante que scoring, detecção e recomendação concordem sobre quais anúncios
-- estavam em escopo: rankings independentes divergem, e aí o score analisa um
-- conjunto e o detector outro.
ALTER TABLE "ads" ADD COLUMN "analysis_eligible_at" TIMESTAMP(3);

-- Toda organização começa com tudo elegível: até a primeira corrida da seleção,
-- o comportamento é exatamente o de hoje. Nenhum anúncio some da análise por
-- causa desta migração.
UPDATE "ads" SET "analysis_eligible_at" = NOW();

CREATE INDEX "ads_ad_account_id_analysis_eligible_at_idx"
  ON "ads"("ad_account_id", "analysis_eligible_at");
