-- Confirmação de email por código de 6 dígitos, no lugar do link.
--
-- O link tirava o usuário do fluxo de cadastro: ele saía para o cliente de
-- email e voltava numa aba nova, sem o plano escolhido e sem sessão. Com o
-- código, a mesma aba que criou a conta confirma o email e segue para o
-- pagamento.

-- Toda linha pendente guarda o hash de um token de link que não tem mais
-- endpoint onde ser resgatado. Deixá-las seria carregar lixo que nunca casa com
-- nada; apagá-las custa ao usuário um clique em "reenviar", que emite um código
-- no formato novo.
DELETE FROM "email_verification_tokens";

-- O hash passou a ser sha256("<account_id>:<código>"). Escopado pela conta,
-- duas contas nunca colidem — mas a MESMA conta pode sortear os mesmos seis
-- dígitos num reenvio, e a linha do sorteio anterior continua na tabela.
-- Mantido o índice único, esse reenvio de 1 em 10^6 viraria um 500.
DROP INDEX IF EXISTS "email_verification_tokens_token_hash_key";

-- Teto de tentativas: 10^6 é adivinhável, cinco palpites não são.
ALTER TABLE "email_verification_tokens"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
