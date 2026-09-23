-- ═══════════════════════════════════════════════════════════════════════════
-- Anexo por mensagem da conversa de suporte
--
-- ## O que faltava
--
-- Só o chamado aceitava print — na abertura, por `POST /support/messages`.
-- Quando o operador pedia "manda um print do erro agora", o cliente não tinha
-- como responder com ele: a resposta era texto, e o único caminho para anexar
-- era abrir outro chamado, partindo a conversa em dois códigos.
--
-- ## Por mensagem, e não mais uma coluna no chamado
--
-- O print pertence ao momento em que foi enviado. Guardá-lo no chamado
-- obrigaria a escolher entre sobrescrever o anterior (perdendo-o) ou virar
-- lista (uma segunda conversa, paralela à primeira). Na mensagem ele fica ao
-- lado do texto que o explica.
--
-- ## O backfill
--
-- A primeira mensagem de cada chamado é a mensagem de abertura — e o print
-- da abertura pertence a ela. Copiá-lo para lá faz a conversa mostrar o
-- anexo onde ele foi enviado. `support_tickets.attachment_*` **não** é
-- apagado: é o registro do envio original, citado no e-mail que já saiu.
--
-- "Primeira mensagem" é a CUSTOMER mais antiga do chamado: é a que a
-- migração `20260921100000_conversa_do_chamado_de_suporte` e o
-- `SendSupportMessageUseCase` gravam com a data de criação do chamado.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "support_ticket_messages"
  ADD COLUMN "attachment_url"              TEXT,
  ADD COLUMN "attachment_key"              TEXT,
  ADD COLUMN "attachment_storage_provider" TEXT,
  ADD COLUMN "attachment_filename"         TEXT;

UPDATE "support_ticket_messages" m
SET "attachment_url"              = t."attachment_url",
    "attachment_key"              = t."attachment_key",
    "attachment_storage_provider" = t."attachment_storage_provider",
    "attachment_filename"         = t."attachment_filename"
FROM "support_tickets" t
WHERE m."ticket_id" = t."id"
  AND t."attachment_url" IS NOT NULL
  AND m."id" = (
    SELECT first."id" FROM "support_ticket_messages" first
    WHERE first."ticket_id" = t."id" AND first."kind" = 'CUSTOMER'
    ORDER BY first."created_at" ASC, first."id" ASC
    LIMIT 1
  );
