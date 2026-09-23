-- Multi-organizacao (Enterprise) + teto de organizacoes por contrato.
--
-- `organizations.owner_id` era UNIQUE, e por isso `CreateOrganizationUseCase`
-- recusava a segunda organizacao de um mesmo dono em QUALQUER plano — inclusive
-- no Enterprise, cujo ICP declarado (holding, rede de franquias, agencia com
-- carteira) precisa exatamente disso. Era a vitrine vendendo o que o schema
-- proibia.
--
-- O UNIQUE vira indice comum: continua servindo a busca por dono, sem impor a
-- cardinalidade. Quantas organizacoes cada conta pode ter passa a ser decisao de
-- plano (`organizations` no catalogo) e de contrato (`max_organizations`), que e
-- onde essa regra pertence.
--
-- Nao ha backfill: toda conta hoje possui no maximo uma organizacao, que e
-- justamente o que o UNIQUE garantia. Remover a restricao nao invalida nenhuma
-- linha existente.
DROP INDEX "organizations_owner_id_key";

CREATE INDEX "organizations_owner_id_idx" ON "organizations"("owner_id");

-- Teto negociado de organizacoes. NULL = herda o plano.
ALTER TABLE "organization_quotas" ADD COLUMN "max_organizations" INTEGER;
