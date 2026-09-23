-- A2-S7 — âncora do teto diário (C10).
--
-- `action_executions` nasceu em A2-S1 sem `created_at`: a tabela registrava
-- quando a execução COMEÇOU (`started_at`) e quando ela VENCE (`expires_at`),
-- mas não quando o pedido entrou. O teto diário conta pedidos, não execuções
-- iniciadas — uma ação ainda em fila já consumiu a intenção de escrever, e
-- contá-la só ao começar deixaria uma janela em que N pedidos enfileirados
-- passam por um teto de 1.
--
-- Aditiva e com default: as linhas existentes recebem `now()`, o que é
-- inexato para elas e irrelevante — nenhuma escrita real aconteceu ainda
-- (`PLATFORM_ACTIONS_ENABLED` nasceu `false`).
ALTER TABLE "action_executions"
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "action_executions_organization_id_created_at_idx"
  ON "action_executions" ("organization_id", "created_at");
