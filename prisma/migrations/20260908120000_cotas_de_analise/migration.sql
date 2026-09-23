-- ═══════════════════════════════════════════════════════════════════════════
-- Cotas de análise — o consumo que o plano governa
--
-- **Aditiva.** Duas colunas de teto negociado e um índice. Nada é reescrito e
-- nada some.
--
-- ## Por que duas colunas e não uma
--
-- `max_creative_analyses_monthly` é uma **parede**: a análise por clique passa
-- a ser recusada no teto, e o contrato Enterprise é o que a move. Antes desta
-- coluna, "sob medida" não tinha onde ser escrito — a rota não tinha teto
-- nenhum para negociar.
--
-- `max_monthly_analyses` **não bloqueia nada**. Ela governa o número que a
-- barra de uso da tela de assinatura mostra, e existe porque esse número vinha
-- de um `PLAN_ANALYSIS_LIMITS` fixo no código, com `9999` para o Enterprise —
-- ou seja, o contrato do cliente não chegava até a tela que ele abre para ver
-- quanto do contrato já usou.
--
-- ## O índice
--
-- A cota de criativo conta `creative_analyses` por organização dentro do mês.
-- O índice existente é `(organization_id, status)` e não serve a essa pergunta:
-- ele agrupa por status, e a contagem filtra por data.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Tetos negociados ────────────────────────────────────────────────────
--
-- `NULL` herda o plano, como as cinco colunas irmãs — nunca "ilimitado".
ALTER TABLE "organization_quotas"
  ADD COLUMN "max_creative_analyses_monthly" INTEGER,
  ADD COLUMN "max_monthly_analyses" INTEGER;

-- ── 2. A contagem da cota ──────────────────────────────────────────────────
CREATE INDEX "creative_analyses_organization_id_started_at_idx"
  ON "creative_analyses" ("organization_id", "started_at");
