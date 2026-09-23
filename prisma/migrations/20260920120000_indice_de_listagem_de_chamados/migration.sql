-- ═══════════════════════════════════════════════════════════════════════════
-- Índice de listagem da Central de suporte
--
-- `GET /api/v1/support/tickets` filtra por organização e ordena por
-- `created_at DESC`, paginando de vinte em vinte. Com
-- `support_tickets_organization_id_idx` sozinho, o Postgres recupera **todas**
-- as linhas da organização e as ordena para entregar a primeira página — a
-- ordenação cresce com o histórico do cliente, e o cliente que mais abre
-- chamado é justamente o Enterprise, que é quem tem a tela.
--
-- O índice composto entrega as linhas já na ordem da consulta. Não substitui
-- `support_tickets_organization_id_idx`: aquele continua servindo as consultas
-- sem ordenação (a agregação por status das abas, e o `count`).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX "support_tickets_organization_id_created_at_idx"
  ON "support_tickets"("organization_id", "created_at" DESC);
