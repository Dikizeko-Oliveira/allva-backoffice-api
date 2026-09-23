-- ═══════════════════════════════════════════════════════════════════════════
-- `accounts.role` passa a responder só "esta conta opera a plataforma?"
--
-- ## O defeito que isto fecha
--
-- `ACCOUNT_ROLE_TYPE` misturava dois eixos. `ADNEXA_ADMIN` e `ADNEXA_OPERATOR`
-- dizem quem opera a Allva; `ADMIN` e `MEMBER` tinham exatamente os nomes dos
-- papéis de organização (`organization_users.role`). E o default era `ADMIN`:
-- toda conta de cliente — inclusive um VIEWER convidado — nascia `ADMIN` aqui e
-- carregava `role: "ADMIN"` no perfil.
--
-- Nenhum código lia `ADMIN` ou `MEMBER` desta coluna. O RBAC de organização lê
-- `organization_users.role`, e as guardas de plataforma só aceitam os dois
-- valores `ADNEXA_*`. Não havia liberação indevida — havia uma armadilha: um
-- `account.role === 'ADMIN'` escrito achando que é o papel na organização, ou
-- `ADMIN` somado à lista de papéis de plataforma, entregaria acesso a todo
-- cliente, e nada falharia.
--
-- ## O que muda
--
-- `MEMBER` e `ADMIN` viram `USER`, que passa a ser o default. Os dois papéis de
-- plataforma ficam intactos, e com eles toda guarda que os compara.
--
-- Postgres não remove valor de enum: o tipo é recriado e o mapeamento vai no
-- `USING`. Nenhuma outra coluna usa `ACCOUNT_ROLE_TYPE`.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "ACCOUNT_ROLE_TYPE_new" AS ENUM ('USER', 'ADNEXA_ADMIN', 'ADNEXA_OPERATOR');

ALTER TABLE "accounts" ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "accounts"
  ALTER COLUMN "role" TYPE "ACCOUNT_ROLE_TYPE_new"
  USING (
    CASE "role"::text
      WHEN 'ADNEXA_ADMIN' THEN 'ADNEXA_ADMIN'
      WHEN 'ADNEXA_OPERATOR' THEN 'ADNEXA_OPERATOR'
      ELSE 'USER'
    END
  )::"ACCOUNT_ROLE_TYPE_new";

ALTER TYPE "ACCOUNT_ROLE_TYPE" RENAME TO "ACCOUNT_ROLE_TYPE_old";
ALTER TYPE "ACCOUNT_ROLE_TYPE_new" RENAME TO "ACCOUNT_ROLE_TYPE";
DROP TYPE "ACCOUNT_ROLE_TYPE_old";

ALTER TABLE "accounts" ALTER COLUMN "role" SET DEFAULT 'USER';
