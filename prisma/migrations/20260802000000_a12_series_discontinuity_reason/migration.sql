-- ═══════════════════════════════════════════════════════════════════════════
-- A12 — `series_discontinuity` é o MOTIVO, não um booleano (§12.5, ⊕4)
--
-- Correção de dívida: A2-S1 declarou o achado A12 como aplicado ("`String?` nos
-- dois"), mas só `ad_scores` nasceu assim. `ad_metric_snapshots` ficou
-- `BOOLEAN NOT NULL DEFAULT false`.
--
-- Um booleano diz que a série quebrou e não diz por quê. Quem lê não distingue
-- "trocamos a moeda-base" de "o anúncio ficou uma semana sem entregar", e as
-- duas pedem tratamentos diferentes. Pior: A2-S4 põe `seriesDiscontinuity`
-- ANTES da coleta dos sinais de feedback negativo justamente para marcar
-- `NEW_SIGNAL` no dia do deploy — e `NEW_SIGNAL` não cabe num `true`.
--
-- É migração ADITIVA, autorizada por E1: o que não é aditivo (partição, unique,
-- NOT NULL) tinha de nascer certo, e nada disso muda aqui. A tabela é
-- particionada, e `ALTER TABLE` sobre a partitioned table propaga às partições.
--
-- Vocabulário fechado (§12.5): NEW_SIGNAL · ATTRIBUTION_WINDOW_CHANGED ·
-- RESUMED_AFTER_PAUSE · ALGO_VERSION_CHANGED · CURRENCY_REBASED. Fica como
-- TEXT, e não como enum, porque `ad_scores` já é TEXT — alinhar os dois tipos é
-- o objetivo do achado, e criar um enum agora desalinharia de novo.
-- ═══════════════════════════════════════════════════════════════════════════

-- A ORDEM IMPORTA, e não é a óbvia. Numa tabela particionada, `ALTER TYPE`
-- reescreve cada partição, e a conversão produz NULL para as linhas `false`. Com
-- a coluna ainda `NOT NULL`, a reescrita da primeira partição falha com 23502.
-- Soltar a restrição antes é o que torna a conversão possível.
ALTER TABLE "ad_metric_snapshots"
  ALTER COLUMN "series_discontinuity" DROP DEFAULT;

ALTER TABLE "ad_metric_snapshots"
  ALTER COLUMN "series_discontinuity" DROP NOT NULL;

-- `false` era o valor de "sem descontinuidade", que agora é NULL. `true` nunca
-- foi gravado por caminho nenhum — o ingest de A2-S3 sequer escreve a coluna —,
-- mas a conversão o preserva como motivo desconhecido em vez de descartá-lo: uma
-- linha marcada por alguém merece investigação, não silêncio.
ALTER TABLE "ad_metric_snapshots"
  ALTER COLUMN "series_discontinuity" TYPE TEXT
  USING (CASE WHEN "series_discontinuity" THEN 'UNSPECIFIED' ELSE NULL END);
