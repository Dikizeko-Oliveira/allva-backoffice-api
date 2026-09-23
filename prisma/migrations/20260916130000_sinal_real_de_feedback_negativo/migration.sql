-- ═══════════════════════════════════════════════════════════════════════════
-- `deterministic-v2` → `deterministic-v2.1` — NegativeFeedbackRiskCalculator
-- passa a ler hides/hide_all_for/reports/unlikes de verdade
--
-- ## O defeito que isto fecha
--
-- `available`/`proxyBased` já liam esses quatro campos para decidir se "o
-- sinal real da plataforma chegou" (§12.2) — mas o composto nunca os olhava:
-- o número era 100% heurístico (frequência, queda de CTR, alta de CPM,
-- saturação) mesmo quando a Meta mandava hides/reports de verdade via Graph
-- API. `proxyBased: false` virava uma afirmação falsa desde o primeiro
-- anúncio Meta com volume suficiente para reportar a ação.
--
-- ## Por que isto precisa de migration, e não só de deploy de código
--
-- `algoVersion` entra no digest de P9 (`computeInputDigest`) e no filtro de
-- `scoreAtOrBefore` que resolve a baseline do delta de 7 dias. Sem o bump:
--   - o próximo ciclo veria o MESMO digest de ontem para série que não mudou
--     e pularia o recomputo — a correção nunca chegaria a rodar;
--   - se rodasse mesmo assim, o delta compararia o score de ontem (proxy) com
--     o de hoje (sinal real) e produziria uma enxurrada de `AD_SCORE_DROPPED`
--     sobre um fato do release, não da mídia.
--
-- Bumpar a versão resolve as duas coisas pelo mecanismo que já existe: digest
-- novo força recompute geral no próximo ciclo, e `scoreAtOrBefore` filtrado
-- por versão não acha baseline sob a versão nova até 7 dias depois do
-- deploy — sem delta a alertar, exatamente como o comentário de
-- `computeDeltas` já previa para este caso.
--
-- ## Escopo
--
-- Só troca o valor para quem ainda está em `deterministic-v2` — organização
-- que já tiver avançado manualmente para outra versão (rollout futuro por
-- organização, D16) não é tocada.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "organization_ads_settings"
  ALTER COLUMN "active_algo_version" SET DEFAULT 'deterministic-v2.1';

UPDATE "organization_ads_settings"
SET "active_algo_version" = 'deterministic-v2.1'
WHERE "active_algo_version" = 'deterministic-v2';
