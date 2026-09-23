-- ═══════════════════════════════════════════════════════════════════════════
-- O teto diário de IA vira cláusula de contrato
--
-- ## O defeito que isto fecha
--
-- `organization_ads_settings.llm_daily_budget_base` ganhou default de R$ 50/dia
-- para que nenhuma organização ficasse sem parede. O número foi calibrado para
-- o maior plano de autoatendimento — e o provisionamento Enterprise cria a
-- linha com os defaults da tabela.
--
-- O resultado, medido: a narrativa noturna sai para todo score novo, a
-- R$ 0,0016 cada. Uma organização Enterprise nova com 40.000 anúncios
-- contratados custa R$ 64/noite e seria cortada em ~31.250 narrativas na
-- primeira madrugada — 22% da entrega contratada, em silêncio, por um número
-- que não é dela.
--
-- O backfill da migração anterior pulou as organizações com
-- `max_monitored_ads` negociado justamente para não fazer isso. Fechou a porta
-- das existentes e deixou a das novas aberta. Isto fecha a segunda.
--
-- ## Por que no contrato, e não derivado por fórmula
--
-- Derivar exigiria uma constante de custo em reais dentro do código — e ela
-- apodrece em silêncio no primeiro reajuste de fornecedor ou de câmbio, sem
-- nada falhar. O número certo é o que o comercial fechou, e `pnpm ai:cost` dá o
-- dado real para preenchê-lo depois de uma semana de operação.
--
-- Nulo continua sendo **sem teto**: um contrato que ainda não precificou IA não
-- pode ser cortado por um default de autoatendimento.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "enterprise_contracts"
  ADD COLUMN "llm_daily_budget_base" DECIMAL(14,4);

-- O aditivo renegocia o teto como renegocia qualquer outro, e carimba o que
-- havia antes: sem o par, "de 200 para 400" vira só "400".
ALTER TABLE "contract_amendments"
  ADD COLUMN "llm_daily_budget_base" DECIMAL(14,4),
  ADD COLUMN "previous_llm_daily_budget_base" DECIMAL(14,4);
