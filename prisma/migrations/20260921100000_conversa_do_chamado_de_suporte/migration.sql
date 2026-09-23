-- ═══════════════════════════════════════════════════════════════════════════
-- A conversa do chamado — `support_ticket_messages` e os carimbos da fila
--
-- ## O que existia, e por que não bastava
--
-- Um `support_tickets` guardava **uma** mensagem: `subject` + `message` +
-- print opcional. Isso descrevia o suporte enquanto ele era um e-mail de mão
-- única, disparado pelo Drawer. O painel de operador (`allva-backoffice-web`)
-- precisa de ida e volta, e precisa de um terceiro tipo de mensagem que o
-- cliente nunca vê — a nota interna, onde o time combina o que já foi
-- tentado e se o caso vai escalar. Sem tipo próprio, essa anotação só teria
-- dois destinos: a caixa de entrada do cliente, ou um canal paralelo onde ela
-- se perde do chamado que a originou.
--
-- ## Três colunas novas em `support_tickets`, e a razão de cada uma
--
-- `last_message_at` — a fila do operador ordena por "quem falou por último".
-- `updated_at` não responde isso: atribuir um responsável ou trocar o status
-- mexe nele sem ninguém ter dito nada, e o chamado subiria para o topo da
-- fila por causa de uma atribuição.
--
-- `resolved_at` — o tempo até a resolução era aproximado por `updated_at`, e a
-- aproximação era exata enquanto **nada além** da mudança de status escrevia
-- no chamado. Uma tabela de mensagens acaba com essa premissa no primeiro
-- "obrigado" que o cliente manda depois de resolvido. Agora há produtor real:
-- a troca de status. Limpo na reabertura — chamado que voltou a OPEN não tem
-- data de resolução.
--
-- `status_changed_at` — o histórico mostra quando o status mudou; derivar de
-- `updated_at` dataria essa mudança na hora da última mensagem.
--
-- ## O backfill
--
-- Cada chamado existente ganha sua mensagem original como primeira linha da
-- conversa, com `kind = CUSTOMER` e a data de criação do chamado — é o que o
-- cliente de fato escreveu, e deixá-la de fora faria toda conversa antiga
-- começar pela resposta do operador.
--
-- `support_tickets.message` **não** é apagada. Dois lugares para o mesmo texto
-- é deliberado: aquela coluna é o corpo do pedido original, citado no e-mail
-- que já saiu, e reescrevê-la ou esvaziá-la mudaria o registro de um envio
-- que já aconteceu.
--
-- `resolved_at` retroativo usa `updated_at` nos chamados já resolvidos: é a
-- mesma aproximação que valia até aqui, e era correta sob a premissa antiga
-- (nada além do status escrevia no chamado). `status_changed_at` fica nulo
-- para todos, inclusive esses: nulo afirma "não sei quando mudou", e é
-- verdade — a data que temos é a de resolução, que já está na coluna própria.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "SupportTicketMessageKind" AS ENUM ('CUSTOMER', 'OPERATOR', 'INTERNAL_NOTE');

-- AlterTable
ALTER TABLE "support_tickets"
  ADD COLUMN "last_message_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "resolved_at"       TIMESTAMP(3),
  ADD COLUMN "status_changed_at" TIMESTAMP(3);

UPDATE "support_tickets" SET "last_message_at" = "created_at";

UPDATE "support_tickets"
SET "resolved_at" = "updated_at"
WHERE "status" IN ('RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "kind" "SupportTicketMessageKind" NOT NULL,
    "author_id" TEXT,
    "author_name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_ticket_messages_ticket_id_created_at_idx"
  ON "support_ticket_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_operator_id_idx" ON "support_tickets"("operator_id");

-- CreateIndex
CREATE INDEX "support_tickets_last_message_at_idx"
  ON "support_tickets"("last_message_at" DESC);

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: a mensagem original vira a primeira linha da conversa.
INSERT INTO "support_ticket_messages" ("id", "ticket_id", "kind", "author_id", "author_name", "body", "created_at")
SELECT gen_random_uuid(), t."id", 'CUSTOMER', t."account_id", t."author_name", t."message", t."created_at"
FROM "support_tickets" t;
