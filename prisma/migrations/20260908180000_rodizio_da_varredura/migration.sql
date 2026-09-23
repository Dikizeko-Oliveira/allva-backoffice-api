-- ═══════════════════════════════════════════════════════════════════════════
-- O rodízio da varredura — a cauda circula, em vez de só os mesmos 300
--
-- ## O defeito
--
-- A régua das 05:00 escolhia os N que mais gastaram e zerava o resto, toda
-- noite. Como o ranking de gasto é estável, **os mesmos anúncios eram olhados
-- para sempre**: um cliente com 5.000 anúncios no plano de 300 tinha 4.700 que a
-- Allva nunca analisou.
--
-- E o modo de falha é o pior possível: um anúncio da cauda que começa a
-- desperdiçar só entra em cena quando sobe no ranking — e ele só sobe gastando
-- mais. O produto encontrava o problema depois que o dinheiro tinha saído.
--
-- ## Por que dá para consertar sem cobrar mais
--
-- A varredura noturna é determinística (P4): detectores e scoring são funções
-- puras sobre snapshots já ingeridos. Não há token de IA nela — o
-- enriquecimento por LLM mora na rota por clique. O teto de N é alavanca de
-- packaging, não parede de custo, e continuam sendo N anúncios por noite. Muda
-- só **quais**.
--
-- ## O que esta coluna resolve
--
-- `analysis_eligible_at` é zerada toda noite para quem ficou de fora, então ela
-- não sabe responder "há quanto tempo este anúncio não é olhado?". Sem essa
-- resposta o rodízio não tem como ordenar por negligência, e viraria sorteio —
-- que é justamente o "corte arbitrário muda de noite para noite" que o desenho
-- original recusou, com razão.
--
-- O carimbo novo **nunca é apagado**. `NULL` significa "nunca analisado", e o
-- rodízio o trata como a maior negligência possível.
--
-- ## O backfill é deliberadamente ausente
--
-- Quem está elegível hoje poderia receber `NOW()`, mas isso afirmaria que os
-- demais nunca entraram — e eles entraram, todas as noites até ontem. Deixar
-- tudo `NULL` faz a primeira corrida tratar a base inteira como igualmente
-- negligenciada e ordenar por gasto, que é exatamente o desempate certo para o
-- primeiro dia.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "ads" ADD COLUMN "analysis_last_scoped_at" TIMESTAMP(3);

-- A faixa de rodízio ordena por negligência dentro da organização.
CREATE INDEX "ads_organization_id_analysis_last_scoped_at_idx"
  ON "ads" ("organization_id", "analysis_last_scoped_at");
