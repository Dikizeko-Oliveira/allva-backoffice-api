-- ═══════════════════════════════════════════════════════════════════════════
-- Resumo diário da organização — P9 aplicado a um texto, não a um anúncio
--
-- O card de "resumo diário com IA" existia no frontend com texto fixo desde
-- sempre: afirmava "seu score caiu de 82 para 67" sem nada ter lido. Esta
-- tabela é o que o torna verdadeiro — e o que impede que ele fique caro.
--
-- **A chave é `(organization_id, digest_date)`**, e é o que garante "uma vez ao
-- dia": o job não consegue gravar duas linhas para o mesmo dia, mesmo se
-- enfileirado duas vezes. A ausência dessa unique transformaria cada retry num
-- resumo novo, com uma chamada de LLM cada.
--
-- **`input_digest` é o que impede o gasto recorrente.** Ele é o hash dos FATOS
-- (gasto, deltas, desperdício aberto, ritmo de orçamento), não do texto. Se os
-- fatos de hoje forem idênticos aos de ontem — conta parada, fim de semana sem
-- veiculação —, o job copia o texto anterior e grava `SKIPPED_DIGEST` em
-- `ai_decision_logs`, sem chamar provider nenhum. É a mesma regra de P9 que já
-- vale para score e análise criativa, aplicada aqui.
--
-- **`facts` é persistido junto do texto**, e não só o texto. Dois motivos: a
-- narrativa é enriquecimento (P4) e o card precisa funcionar inteiro com a IA
-- fora; e sem os fatos gravados não há como auditar depois se o texto do dia 12
-- descrevia o que de fato acontecia no dia 12.
--
-- Migração ADITIVA: tabela nova, nenhuma coluna existente muda.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "organization_daily_digests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,

    -- O dia a que o resumo se refere, em UTC. `DATE` e não `TIMESTAMP`: o
    -- resumo é do dia, e um instante permitiria duas linhas para o mesmo dia.
    "digest_date" DATE NOT NULL,

    -- Hash dos fatos. Igual ao do dia anterior ⇒ nenhuma chamada de LLM.
    "input_digest" TEXT NOT NULL,

    -- Os fatos determinísticos que sustentam o texto. São a resposta quando a
    -- IA não está disponível.
    "facts" JSONB NOT NULL,

    -- `NULL` quando a IA não pôde falar: provider fora, teto de custo atingido,
    -- ou nenhuma chave configurada. O card continua inteiro com os fatos.
    "narrative" TEXT,
    "enriched_by_ai" BOOLEAN NOT NULL DEFAULT false,

    -- D16: `activePromptVersions` é um mapa por tarefa, e a versão que produziu
    -- ESTE texto viaja com ele — sem isso, dois resumos da mesma semana podem
    -- ter vindo de réguas diferentes e ninguém consegue saber.
    "prompt_version" TEXT,

    -- Quando o texto foi copiado de um dia anterior por digest igual, aponta
    -- para a origem. Torna a economia auditável na própria linha.
    "reused_from_date" DATE,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_daily_digests_pkey" PRIMARY KEY ("id")
);

-- Uma linha por organização por dia. É o que faz "uma vez ao dia" ser
-- invariante de banco, e não promessa do agendador.
CREATE UNIQUE INDEX "organization_daily_digests_org_date_key"
    ON "organization_daily_digests"("organization_id", "digest_date");

-- A leitura do card é sempre "o mais recente desta organização".
CREATE INDEX "organization_daily_digests_org_date_idx"
    ON "organization_daily_digests"("organization_id", "digest_date" DESC);

ALTER TABLE "organization_daily_digests"
    ADD CONSTRAINT "organization_daily_digests_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
