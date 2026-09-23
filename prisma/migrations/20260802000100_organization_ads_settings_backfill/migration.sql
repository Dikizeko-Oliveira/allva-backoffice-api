-- ═══════════════════════════════════════════════════════════════════════════
-- D16/A10 — toda organização tem `organization_ads_settings`
--
-- Correção de dívida: a tabela nasceu em A2-S1 e **ninguém a criava**. A única
-- linha existente veio do seed de desenvolvimento; uma organização provisionada
-- por lead `CLOSED_WON` nascia sem configuração nenhuma.
--
-- Isso não é um detalhe de completude. D16 existe para que "versão ativa" NÃO
-- seja constante de código: `activeAlgoVersion`, `activeDetectorProfileVersion`,
-- `scoringWindowDays`, `llmDailyBudgetBase` e `actionDailyCap` são a
-- configuração que A2-S4 em diante lê por organização. Sem a linha, o scoring
-- teria de inventar um default no código — que é exatamente o que a decisão
-- recusou — ou pular a organização em silêncio.
--
-- Idempotente: `ON CONFLICT DO NOTHING` sobre a PK (`organization_id`). Os
-- valores vêm dos DEFAULTs declarados na tabela, então o backfill não decide
-- nada — só materializa a configuração padrão para quem nasceu sem ela.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "organization_ads_settings" ("organization_id", "updated_at")
SELECT "id", now() FROM "organizations"
ON CONFLICT ("organization_id") DO NOTHING;
