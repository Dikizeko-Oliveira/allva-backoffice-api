-- Quando um humano declarou o nome da organização.
--
-- NULL = nome derivado da conta pelo provisionamento do cadastro, nunca
-- confirmado. É o sinal que a tela de convite lê para pedir o rename no único
-- momento em que ele importa: antes do primeiro convite, que é quando o nome
-- passa a ser lido por terceiros.
ALTER TABLE "organizations" ADD COLUMN "name_confirmed_at" TIMESTAMP(3);

-- Backfill em duas etapas, e não um default.
--
-- Toda organização que já existe teve o nome digitado por alguém — pelo modal
-- do produto ou pela razão social do lead —, então carimbar `created_at` é a
-- afirmação verdadeira. Perguntar retroativamente a esse pessoal seria ruído.
UPDATE "organizations" SET "name_confirmed_at" = "created_at";

-- A exceção são as provisionadas automaticamente. Elas se identificam pela
-- trilha que o próprio provisionamento escreveu (`metadata->>'source'`), e não
-- por heurística sobre o nome — que erraria nos dois sentidos.
UPDATE "organizations" o
   SET "name_confirmed_at" = NULL
  FROM "audit_logs" a
 WHERE a."entity_id" = o."id"
   AND a."event" = 'organization.created'
   AND a."metadata"->>'source' IN ('signup', 'integration', 'backfill');
