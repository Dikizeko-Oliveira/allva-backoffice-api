-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — isolamento de tenant no armazenamento (R9)
--
-- §18 lista R9 como **média · crítico** e a mitigação em três partes:
-- `organizationId NOT NULL` denormalizado, teste de tenancy por endpoint, e
-- "RLS avaliado em S9". A avaliação (`docs/decisao-rls.md`) concluiu por NÃO
-- ativar — e listou três gatilhos de reabertura. O gatilho 2, **exigência de
-- conformidade**, passou a valer.
--
-- ## O que esta migração faz, e o que deliberadamente NÃO faz
--
-- Cria os dois papéis, liga RLS e escreve as políticas nas duas maiores tabelas.
-- **Não** troca o papel da aplicação: `DATABASE_URL` continua apontando para o
-- dono das tabelas, que tem BYPASSRLS implícito. A troca é mudança de ambiente,
-- reversível por variável, e pertence a quem opera — não a um DDL que já rodou.
--
-- O efeito prático: RLS existe, é verificável por teste conectando como
-- `app_rw`, e nada quebra enquanto a aplicação não trocar de papel.
--
-- ## Por que estas duas tabelas primeiro
--
-- `ad_metric_snapshots` e `waste_items` são as maiores e as duas **sem exceção
-- de `organization_id` nulo** — a política sai limpa, sem `OR ... IS NULL`, que
-- é o furo que tornaria a política pior que a ausência dela.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Os dois papéis ──────────────────────────────────────────────────────
--
-- `app_rw` **sem** BYPASSRLS: é sob ele que a aplicação passa a rodar, e é a
-- ausência do bypass que faz a política valer. `app_maintenance` **com**: os
-- jobs globais de §8.8 — partições, câmbio, retenção, reaper — atravessam
-- tenants por desenho, e negar isso a eles quebraria a manutenção do banco.
--
-- Senha nenhuma aqui. Ela é definida por quem opera, fora do controle de versão.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_rw, app_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO app_rw, app_maintenance;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO app_rw, app_maintenance;

-- Tabelas criadas depois desta migração herdam os grants: sem isto, a primeira
-- tabela nova faria a aplicação falhar com "permission denied" em produção, e o
-- erro apontaria para a consulta em vez de para a causa.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw, app_maintenance;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw, app_maintenance;

-- ── 2. O tenant corrente ───────────────────────────────────────────────────
--
-- `current_setting('app.organization_id', true)` devolve NULL quando a variável
-- não foi setada — o `true` é o que evita a exceção. A política compara com ela,
-- e NULL não casa com nada: **uma consulta sem o `SET LOCAL` devolve zero
-- linhas**, que é exatamente o comportamento desejado. Silêncio, não vazamento.
CREATE OR REPLACE FUNCTION current_organization_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '') $$;

-- ── 3. As políticas ────────────────────────────────────────────────────────
ALTER TABLE "ad_metric_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waste_items" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "ad_metric_snapshots";
DROP POLICY IF EXISTS tenant_isolation ON "waste_items";

-- `USING` filtra a leitura; `WITH CHECK` impede a **escrita** de linha de outro
-- tenant. Só `USING` deixaria uma organização gravar no espaço da outra e
-- perder a linha de vista em seguida — pior que ler, porque é silencioso.
CREATE POLICY tenant_isolation ON "ad_metric_snapshots"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());

CREATE POLICY tenant_isolation ON "waste_items"
  USING ("organization_id" = current_organization_id())
  WITH CHECK ("organization_id" = current_organization_id());
