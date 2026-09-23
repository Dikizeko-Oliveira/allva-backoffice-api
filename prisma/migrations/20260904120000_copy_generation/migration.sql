-- ═══════════════════════════════════════════════════════════════════════════
-- Geração de copy — §11.4 passo 5 em diante
--
-- **Aditiva.** Nenhuma coluna some, nenhuma tabela é reescrita. As quatro
-- colunas de sugestão de `creative_analyses` já existiam desde A2-S1 e apenas
-- passam a ser escritas; o que nasce aqui é a persistência do texto gerado.
--
-- ## Por que duas tabelas e não uma
--
-- `copy_generations` é o **pedido**, com a procedência inteira: contexto, digest,
-- prompt, provider. `copy_variants` são as três hipóteses que saíram dele. Uma
-- tabela só guardaria o contexto três vezes e faria "qual sugestão melhorou o
-- desempenho?" virar um GROUP BY sobre JSON duplicado.
--
-- ## `applied_action_execution_id` nasce sem leitor
--
-- É deliberado, e é a única coluna aqui cuja ausência seria irreversível: sem
-- ela, toda variante gerada antes da entrega de medição ficaria permanentemente
-- não-mensurável. Custa uma coluna agora; custaria o histórico inteiro depois.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Vocabulário ─────────────────────────────────────────────────────────
CREATE TYPE "CopyGenerationSource" AS ENUM ('FROM_INSIGHT', 'IMPROVE', 'FROM_BRIEF');
CREATE TYPE "CopyGenerationStatus" AS ENUM ('COMPLETED', 'AI_UNAVAILABLE');
CREATE TYPE "CopyAngle" AS ENUM ('BENEFIT', 'PAIN', 'OUTCOME', 'PROOF', 'URGENCY');

-- ── 2. O teto negociado por contrato ───────────────────────────────────────
--
-- `NULL` herda o plano, como as quatro colunas irmãs — nunca "ilimitado".
ALTER TABLE "organization_quotas"
  ADD COLUMN "max_copy_generations_monthly" INTEGER;

-- ── 3. O pedido ────────────────────────────────────────────────────────────
CREATE TABLE "copy_generations" (
  "id"              TEXT NOT NULL,
  -- G2: NOT NULL, como toda tabela de inteligência. É o que torna a política de
  -- RLS abaixo escrevível sem `OR ... IS NULL` — o furo que tornaria a política
  -- pior que a ausência dela.
  "organization_id" TEXT NOT NULL,
  "account_id"      TEXT NOT NULL,
  -- Nunca nulo, inclusive em FROM_BRIEF: geração sem anúncio não é mensurável,
  -- não é aplicável, e é a única forma que chega perto de originar mídia (P1).
  "ad_id"           TEXT NOT NULL,
  "creative_id"     TEXT,
  "analysis_id"     TEXT,
  "ad_score_id"     TEXT,
  "source"          "CopyGenerationSource" NOT NULL,
  "status"          "CopyGenerationStatus" NOT NULL,
  "context"         JSONB NOT NULL,
  "input_digest"    TEXT NOT NULL,
  "engine_version"  TEXT NOT NULL,
  "prompt_version"  TEXT NOT NULL,
  "ai_provider"     TEXT,
  "ai_model"        TEXT,
  "failure_reason"  TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- D5: elegibilidade a expurgo, carimbada com a política vigente na criação.
  -- Mudar o prazo depois não pode apagar retroativamente o que foi gerado sob a
  -- promessa anterior.
  "retention_until" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "copy_generations_pkey" PRIMARY KEY ("id")
);

-- ── 4. As variações ────────────────────────────────────────────────────────
CREATE TABLE "copy_variants" (
  "id"              TEXT NOT NULL,
  "generation_id"   TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "angle"           "CopyAngle" NOT NULL,
  "hook"            TEXT,
  "primary_text"    TEXT,
  "headline"        TEXT,
  "description"     TEXT,
  "call_to_action"  TEXT,
  "reasoning"       JSONB NOT NULL,
  "selected"        BOOLEAN NOT NULL DEFAULT false,
  "selected_at"     TIMESTAMP(3),
  "applied_action_execution_id" TEXT,
  "applied_at"      TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "copy_variants_pkey" PRIMARY KEY ("id")
);

-- ── 5. Índices ─────────────────────────────────────────────────────────────
CREATE INDEX "copy_generations_organization_id_ad_id_created_at_idx"
  ON "copy_generations" ("organization_id", "ad_id", "created_at" DESC);
-- O reuso quando nada mudou entra por aqui.
CREATE INDEX "copy_generations_organization_id_input_digest_idx"
  ON "copy_generations" ("organization_id", "input_digest");
-- A cota mensal conta por aqui: só `COMPLETED` do mês corrente consome.
CREATE INDEX "copy_generations_organization_id_status_created_at_idx"
  ON "copy_generations" ("organization_id", "status", "created_at");
CREATE INDEX "copy_generations_retention_until_idx"
  ON "copy_generations" ("retention_until");

CREATE INDEX "copy_variants_organization_id_generation_id_idx"
  ON "copy_variants" ("organization_id", "generation_id");
CREATE INDEX "copy_variants_applied_action_execution_id_idx"
  ON "copy_variants" ("applied_action_execution_id");

-- ── 6. Chaves ──────────────────────────────────────────────────────────────
ALTER TABLE "copy_generations"
  ADD CONSTRAINT "copy_generations_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "copy_generations"
  ADD CONSTRAINT "copy_generations_ad_id_fkey"
  FOREIGN KEY ("ad_id") REFERENCES "ads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "copy_variants"
  ADD CONSTRAINT "copy_variants_generation_id_fkey"
  FOREIGN KEY ("generation_id") REFERENCES "copy_generations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 7. RLS ─────────────────────────────────────────────────────────────────
--
-- As duas entram nas políticas desde o nascimento. Conteúdo de marca do cliente
-- é justamente o tipo de tabela que não pode ficar esperando uma segunda leva:
-- sem `SET LOCAL app.organization_id`, a consulta devolve zero linhas.
--
-- `WITH CHECK` além de `USING` pelo mesmo motivo da migração de R9: só `USING`
-- deixaria uma organização gravar no espaço da outra e perder a linha de vista
-- em seguida — pior que ler, porque é silencioso.
ALTER TABLE "copy_generations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "copy_variants" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "copy_generations";
DROP POLICY IF EXISTS tenant_isolation ON "copy_variants";

CREATE POLICY tenant_isolation ON "copy_generations"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

CREATE POLICY tenant_isolation ON "copy_variants"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
