# Allva Backoffice API

Backend dos processos internos do backoffice Allva.

Este serviço **não** é dono de dados do produto. Organizações, contas, contratos assinados,
faturas, assinaturas, integrações, leads, contatos, chamados e permissões de plataforma continuam
no `allva-api`. O `allva-backoffice-api` guarda apenas dados que fazem sentido para a operação
interna da Allva.

## Responsabilidades

- Introspectar o operador no `allva-api` via `GET /api/v1/auth/me`.
- Autorizar por `platformPermissions`, nunca por papel.
- Expor sinais internos do hub em `GET /api/v1/hub/attention`.
- Enriquecer a fila de suporte com SLA, risco e escalonamento.
- Registrar histórico interno de atribuição de chamados.
- Gerir políticas de SLA.
- Guardar notas internas sobre organizações, contas, leads e contratos.
- Guardar preferências e visões salvas do operador.
- Gerir alertas operacionais internos e reconhecimento.
- Guardar minutas pré-assinatura e converter contrato assinado chamando o `allva-api`.
- Auditar todas as escritas internas.

## Fora de escopo

Este repositório não implementa o produto nem duplica tabelas/rotas do `allva-api`.
Referências ao produto são ids opacos e chamadas HTTP autenticadas com o bearer token do operador.

## Stack

- NestJS
- TypeScript
- PostgreSQL
- Prisma

## Configuração local

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm prisma migrate deploy
pnpm dev
```

Variáveis principais (`DATABASE_URL` e `ALLVA_API_URL` são obrigatórias — sem elas o
processo não sobe):

```env
PORT=8081
DATABASE_URL=postgresql://allva_backoffice_user:allva_backoffice_password@localhost:5433/allva_backoffice_db
ALLVA_API_URL=http://localhost:8080
FRONTEND_URL=http://localhost:3001
```

O banco é **próprio**, separado do `allva_db` do produto: históricos de migração
independentes, e nenhuma FK para dado do produto — referências são ids opacos.

## Scripts

```bash
pnpm typecheck
pnpm build
pnpm test
```

## Estrutura

Mesma arquitetura limpa do `allva-api`:

```text
src/modules/auth             identidade do operador (introspecção no allva-api) e autorização
src/modules/operations-hub   sinais internos do Operations Hub
src/modules/support          SLA, fila enriquecida, métricas e atribuições
src/modules/internal-notes   notas internas
src/modules/preferences      preferências e visões salvas
src/modules/alerts           alertas internos
src/modules/contract-drafts  minutas pré-assinatura
src/modules/audit            auditoria do backoffice-api
src/modules/health           sonda do balanceador (módulo plano, sem regra)
src/shared                   config, contexto, banco, paginação e o cliente HTTP do allva-api
```

Cada módulo tem três camadas:

```text
<módulo>/
  <módulo>.module.ts
  domain/          entidades, regras puras, ports (abstract class) — sem Nest, sem Prisma
  application/     use cases, DTOs, presenters — falam só com ports
  infrastructure/
    database/prisma/   repositórios
    providers/         gateways HTTP para o allva-api
    http/controllers/  controllers finos: extraem entrada e chamam um use case
```

Regras cobradas em `test/architecture/` (rodam em `pnpm test`):

- `domain/` não importa `application/`, `infrastructure/`, Nest nem Prisma.
- `application/` não importa `infrastructure/` de módulo; só a infraestrutura toca o Prisma.
- Todo port é `abstract class`; nenhum use case passa de ~150 linhas.
- **Toda autorização mora no use case** (`assertPlatformPermission`), nunca em guard
  de rota nem por papel. Um use case sem checagem reprova o CI.
- O grafo de injeção do `AppModule` inteiro monta.

O contrato completo está em [docs/backoffice-api.md](docs/backoffice-api.md).
