-- ═══════════════════════════════════════════════════════════════════════════
-- A marca vira Allva: ADNEXA_* → ALLVA_* em `ACCOUNT_ROLE_TYPE`
--
-- ## Renomear o rótulo, não recriar o tipo
--
-- `ALTER TYPE ... RENAME VALUE` troca o rótulo no catálogo sem tocar em uma
-- linha sequer: o OID do valor não muda, e `accounts.role` acompanha sozinho.
-- É por isso que aqui não há o `CREATE TYPE ... USING ...` de
-- `20260913120000_papel_de_conta_so_plataforma` — aquele precisava **remover**
-- valores, o que o Postgres não faz; renomear ele faz, e barato.
--
-- ## Idempotente por rótulo, não por migração
--
-- `RENAME VALUE` não aceita `IF EXISTS`, e reaplicar sobre um banco já
-- renomeado erraria com "label does not exist". O `IF EXISTS` no `pg_enum`
-- cobre isso, pelo mesmo motivo de `20260921120000_papeis_de_plataforma_por_area`:
-- uma migração que quebra ao ser reaplicada vira um deploy travado no meio.
--
-- ## Por que o histórico continua dizendo ADNEXA
--
-- As migrações anteriores **não** foram reescritas. Elas registram o SQL que já
-- rodou em cada ambiente, e o Prisma guarda o checksum de cada uma em
-- `_prisma_migrations`: editar um arquivo já aplicado faz `migrate deploy`
-- recusar o deploy inteiro. Um banco novo continua nascendo com os rótulos
-- antigos nas primeiras migrações e chegando aqui com os novos — o estado
-- final é o mesmo, e é o que o `schema.prisma` declara.
--
-- ## O log de auditoria vem junto
--
-- `account.platform_role.updated` guarda `{from, to}` com o nome do papel em
-- texto livre. Deixá-los como estão criaria linhas apontando para papéis que
-- não existem mais em nenhum lugar — uma trilha que ninguém consegue cruzar
-- com a matriz de permissões. Como não há conta real na plataforma nesta
-- data, reescrever é consistência, não perda de história.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  antigo text;
BEGIN
  FOREACH antigo IN ARRAY ARRAY[
    'ADNEXA_ADMIN',
    'ADNEXA_OPERATOR',
    'ADNEXA_SUPPORT',
    'ADNEXA_FINANCE',
    'ADNEXA_SALES'
  ] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ACCOUNT_ROLE_TYPE'
        AND e.enumlabel = antigo
    ) THEN
      EXECUTE format(
        'ALTER TYPE "ACCOUNT_ROLE_TYPE" RENAME VALUE %L TO %L',
        antigo,
        replace(antigo, 'ADNEXA_', 'ALLVA_')
      );
    END IF;
  END LOOP;
END $$;

UPDATE "audit_logs"
SET "metadata" = replace("metadata"::text, 'ADNEXA_', 'ALLVA_')::jsonb
WHERE "metadata"::text LIKE '%ADNEXA%';

UPDATE "security_audit_logs"
SET "metadata" = replace("metadata"::text, 'ADNEXA_', 'ALLVA_')::jsonb
WHERE "metadata"::text LIKE '%ADNEXA%';
