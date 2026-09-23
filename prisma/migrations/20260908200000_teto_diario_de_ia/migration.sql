-- ═══════════════════════════════════════════════════════════════════════════
-- O teto diário de IA passa a existir
--
-- ## O defeito
--
-- `llm_daily_budget_base` nasceu anulável e sem default, e `evaluateBudget`
-- documenta que nulo **permite**. Como o provisionamento cria a linha com os
-- defaults da tabela, nenhuma organização tinha teto: a parede que o catálogo
-- cita como "por onde o dinheiro de fato sai" não existia em lugar nenhum.
--
-- E o que ela deveria conter é o maior gasto de IA do produto. A narrativa
-- noturna sai para **todo score novo** — ~2.000/noite no teto do Profissional,
-- R$ 3,30/dia, R$ 99/mês por organização num plano de R$ 497. As duas cotas
-- mensais do Creative Lab não a alcançam: elas medem o que se pede por clique,
-- e esta é produzida pelo job da madrugada sozinho.
--
-- ## Por que 50
--
-- Parede de descontrole, não orçamento. Ela não pode cortar o que o plano vende
-- nem no pior caso previsto: com a OpenAI fora do ar a rota cai para
-- `claude-sonnet-5`, 8,8× mais caro, e os 2.000 anúncios do Profissional custam
-- R$ 28,86/dia. Um teto abaixo disso transformaria incidente de fornecedor em
-- queda de produto.
--
-- Em operação normal o Profissional gasta ~R$ 3,80/dia — 7% do teto. Bater nele
-- significa que algo quebrou.
--
-- ## O backfill pula quem negociou escala
--
-- Organização com `max_monitored_ads` gravado é contrato Enterprise, e o
-- contrato pode vender 40.000 anúncios — R$ 66/dia só de narrativa. Aplicar 50
-- ali cortaria a entrega contratada na primeira madrugada, que é o oposto do
-- que esta migração existe para fazer. Elas seguem sem teto até o operador
-- gravar o número do contrato, e a rota para isso nasce junto com esta coluna.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "organization_ads_settings"
  ALTER COLUMN "llm_daily_budget_base" SET DEFAULT 50;

UPDATE "organization_ads_settings" s
   SET "llm_daily_budget_base" = 50
 WHERE s."llm_daily_budget_base" IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM "organization_quotas" q
      WHERE q."organization_id" = s."organization_id"
        AND q."max_monitored_ads" IS NOT NULL
   );
