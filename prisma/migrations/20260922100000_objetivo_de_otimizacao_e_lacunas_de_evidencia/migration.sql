-- ═══════════════════════════════════════════════════════════════════════════
-- Objetivo de otimização por campanha e conjunto, lacunas de evidência por
-- anúncio, e `deterministic-v2.1` → `deterministic-v2.2`
--
-- ## O defeito que isto fecha
--
-- Nenhum detector sabia para que o anúncio foi otimizado, e no Meta "conversão"
-- era só compra. Um anúncio de lead (Meta) ou de alcance/tráfego (qualquer
-- plataforma) aparecia com zero conversões e `ZERO_CONVERSIONS` recomendava
-- pausá-lo. O `audienceFit` do score tinha o mesmo defeito: se declarava
-- disponível com conversão zero e puxava o AI Score para baixo.
--
-- ## O que entra
--
-- - `campaigns`/`ad_sets`: `optimization_class`, `conversion_event`,
--   `conversion_measurable` — a tradução canônica que cada provider faz do
--   vocabulário da sua plataforma. Nulo = ainda não lido; o próximo sync
--   preenche.
-- - `ads.evidence_gaps` + `evidence_gaps_as_of`: o que a detecção não pôde
--   julgar em cada anúncio, e quando a evidência deve chegar.
--
-- ## Por que o bump de `active_algo_version`
--
-- `audienceFit` deixa de valer para anúncio sem objetivo de conversão, e o teto
-- de cobertura deixa de cobrar o peso dele — o score desses anúncios muda por um
-- fato do release, não da mídia. Mesmo raciocínio de
-- `20260916130000_sinal_real_de_feedback_negativo`: a versão nova força o
-- recompute (ela entra no digest de P9) e impede o delta de 7 dias de comparar
-- réguas diferentes, o que dispararia `AD_SCORE_DROPPED` em massa.
--
-- Só avança quem está em `deterministic-v2.1`: organização que tiver ido para
-- outra versão por rollout próprio (D16) não é tocada.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "OptimizationClass" AS ENUM (
  'CONVERSION',
  'TRAFFIC',
  'AWARENESS',
  'ENGAGEMENT',
  'UNKNOWN'
);

ALTER TABLE "campaigns"
  ADD COLUMN "optimization_class" "OptimizationClass",
  ADD COLUMN "conversion_event" TEXT,
  ADD COLUMN "conversion_measurable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ad_sets"
  ADD COLUMN "optimization_class" "OptimizationClass",
  ADD COLUMN "conversion_event" TEXT,
  ADD COLUMN "conversion_measurable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ads"
  ADD COLUMN "evidence_gaps" JSONB,
  ADD COLUMN "evidence_gaps_as_of" TIMESTAMP(3);

ALTER TABLE "organization_ads_settings"
  ALTER COLUMN "active_algo_version" SET DEFAULT 'deterministic-v2.2';

UPDATE "organization_ads_settings"
SET "active_algo_version" = 'deterministic-v2.2'
WHERE "active_algo_version" = 'deterministic-v2.1';
