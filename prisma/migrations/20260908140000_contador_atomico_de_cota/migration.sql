-- ═══════════════════════════════════════════════════════════════════════════
-- O contador atômico de cota — o fim do "101 de 100"
--
-- ## O defeito
--
-- As duas cotas mensais liam `COUNT(*)` e depois inseriam. Entre as duas
-- operações não havia trava, então dois pedidos simultâneos com 99 de 100
-- usados liam 99 os dois, os dois passavam, e o mês fechava em 101. O teto
-- valia "na média", e a tela de assinatura exibia a falha em letras grandes.
--
-- ## A correção
--
-- A reserva passa a **ser** a escrita:
--
--   INSERT … ON CONFLICT (…) DO UPDATE SET used = used + 1 WHERE used < $limite
--
-- O `WHERE` do `DO UPDATE` é avaliado **depois** de o Postgres travar a linha em
-- conflito, então o segundo pedido enxerga o incremento do primeiro. Zero linhas
-- devolvidas significa "não coube". Não existe janela onde caibam dois.
--
-- ## Por que não é o contador que a cota de copy recusou ter
--
-- Aquele argumento era contra um **espelho** da tabela: fechamento de mês e
-- conciliação. Nenhum dos dois existe aqui. O período faz parte da chave
-- primária, então virar o mês é inserir outra linha — não há job de fechamento.
-- E o que se conta é *autorização concedida*, não linha produzida: quando o
-- trabalho autorizado não acontece, quem reservou devolve a unidade, e as duas
-- visões convergem sem ninguém acertá-las depois.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. A tabela ────────────────────────────────────────────────────────────
CREATE TABLE "organization_usage_counters" (
  "organization_id" TEXT NOT NULL,
  -- A chave do catálogo. Texto e não enum: linha nova de packaging não deve
  -- exigir migração.
  "feature"         TEXT NOT NULL,
  -- Primeiro instante do mês em UTC — o mesmo `monthWindow` que as guardas usam.
  "period_start"    TIMESTAMP(3) NOT NULL,
  "used"            INTEGER NOT NULL DEFAULT 0,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A PK é o que torna o `ON CONFLICT` possível, e é por ela que a trava de
  -- linha serializa dois pedidos concorrentes da mesma organização.
  CONSTRAINT "organization_usage_counters_pkey"
    PRIMARY KEY ("organization_id", "feature", "period_start")
);

ALTER TABLE "organization_usage_counters"
  ADD CONSTRAINT "organization_usage_counters_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Um contador nunca pode ficar negativo: a devolução usa GREATEST(used - 1, 0),
-- e esta restrição é o que garante que nenhum caminho futuro a contorne.
ALTER TABLE "organization_usage_counters"
  ADD CONSTRAINT "organization_usage_counters_used_nao_negativo"
  CHECK ("used" >= 0);

-- ── 2. O consumo que já aconteceu neste mês ────────────────────────────────
--
-- **Sem isto, a troca daria um mês grátis a todo mundo.** O contador nasceria em
-- zero e quem já tivesse gasto as 20 gerações do Individual ganharia mais 20 —
-- exatamente o furo que esta migração existe para fechar.
--
-- A janela é a mesma das guardas: início do mês em UTC.
INSERT INTO "organization_usage_counters"
  ("organization_id", "feature", "period_start", "used", "updated_at")
SELECT
  "organization_id",
  'copy-generation',
  date_trunc('month', (NOW() AT TIME ZONE 'UTC')),
  COUNT(*),
  NOW()
FROM "copy_generations"
-- Só concluídas, como a guarda sempre contou: uma geração que caiu por provider
-- fora do ar não entregou nada e não é cobrada.
WHERE "status" = 'COMPLETED'
  AND "created_at" >= date_trunc('month', (NOW() AT TIME ZONE 'UTC'))
GROUP BY "organization_id"
ON CONFLICT DO NOTHING;

INSERT INTO "organization_usage_counters"
  ("organization_id", "feature", "period_start", "used", "updated_at")
SELECT
  "organization_id",
  'creative-analyses',
  date_trunc('month', (NOW() AT TIME ZONE 'UTC')),
  COUNT(*),
  NOW()
FROM "creative_analyses"
WHERE "started_at" >= date_trunc('month', (NOW() AT TIME ZONE 'UTC'))
GROUP BY "organization_id"
ON CONFLICT DO NOTHING;
