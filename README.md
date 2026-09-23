# Allva Backoffice API

Backend dos processos internos do backoffice Allva.

Este serviço **não** é dono de dados do produto. Organizações, contas, contratos assinados,
faturas, assinaturas, integrações, leads, contatos, chamados e permissões de plataforma continuam
no `allva-api`. O `allva-backoffice-api` guarda apenas dados que fazem sentido para a operação
interna da Allva.

## Responsabilidades

- Introspectar o operador no `allva-api` via `GET /api/v1/auth/me`.
- Autorizar por `platformPermissions`, nunca por papel.
- Expor sinais internos do hub em `GET /hub/attention`.
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

Variáveis principais:

```env
PORT=8081
DATABASE_URL=postgresql://allva_backoffice_user:allva_backoffice_password@localhost:5433/allva_backoffice_db
ALLVA_API_URL=http://localhost:8080
FRONTEND_URL=http://localhost:3001
```

## Scripts

```bash
pnpm typecheck
pnpm build
pnpm test
```

## Estrutura

```text
src/modules/auth         introspecção e guardas de permissão
src/modules/product      cliente HTTP do allva-api
src/modules/hub          sinais internos do Operations Hub
src/modules/support      SLA, fila enriquecida, métricas e atribuições
src/modules/notes        notas internas
src/modules/preferences  preferências e visões salvas
src/modules/alerts       alertas internos
src/modules/contracts    minutas pré-assinatura
src/modules/audit        auditoria do backoffice-api
src/shared               infraestrutura comum mínima
```

O contrato completo está em [docs/backoffice-api.md](docs/backoffice-api.md).
