# Decisão: Row-Level Security (R9)

> **A2-S9, entrega 6.** §18 lista R9 — *"regressão de tenancy durante o refactor"* —
> como **média · crítico**, com a mitigação em três partes: `organizationId NOT NULL`
> denormalizado em tudo, teste de tenancy por endpoint, e **RLS avaliado em S9**.
> Este documento é essa avaliação, e a decisão que ela produziu.
>
> **Data:** 2026-08-03 · **Revista:** 2026-08-04 · **Estado:** **invertida**

---

## A decisão, e a reversão

**Decisão original (2026-08-03): não ativar RLS na v2.0**, mantendo a tenancy na
aplicação e adicionando o gate G16 para que a pré-condição não se degradasse — a
condição que mantinha a decisão reversível.

**Revertida em 2026-08-04**, um dia depois. O gatilho 2 da lista de reabertura —
**exigência de conformidade** — passou a valer. A decisão foi tomada com a
informação disponível e a informação mudou; é para isso que os gatilhos foram
escritos.

> Registrar a decisão original **e** a reversão, em vez de reescrever o
> documento como se ele sempre tivesse dito "sim", é o que torna o próximo
> gatilho verificável. Um documento que só mostra a conclusão atual não ensina
> nada sobre quando reabrir.

## O que está entregue

| Peça | Onde |
|---|---|
| Papéis `app_rw` (sem bypass) e `app_maintenance` (com) | [migration.sql](../prisma/migrations/20260804000000_rls_tenant_isolation/migration.sql) |
| `current_organization_id()` + políticas `USING`/`WITH CHECK` | idem — `ad_metric_snapshots` e `waste_items` |
| Publicação do tenant ao Postgres, por operação | [prisma.service.ts](../src/shared/infrastructure/database/prisma/prisma.service.ts) |
| Store de tenant, separado do contexto de requisição | [tenant-scope.ts](../src/shared/infrastructure/database/prisma/tenant-scope.ts) |
| Isolamento **verificado como `app_rw`** | [rls-tenant-isolation.spec.ts](../test/integration/rls-tenant-isolation.spec.ts) |

**O contrato em uma frase:** sem `SET LOCAL app.organization_id`, a consulta
devolve **zero linhas**. Falha fechada — o pior desfecho é uma tela vazia, nunca
dado do tenant errado.

## As três decisões de execução

1. **A aplicação ainda não trocou de papel.** `DATABASE_URL` continua apontando
   para o dono das tabelas, que tem `BYPASSRLS` implícito. RLS existe, é
   verificável por teste, e **nada quebra** até quem opera trocar a variável. A
   troca é de ambiente e reversível; embuti-la num DDL que já rodou não seria.

2. **O teste conecta como `app_rw`, e é a única forma de ele significar algo.**
   Um teste que passasse pela `PrismaService` normal reportaria isolamento sem
   ter verificado nada — o dono enxerga tudo por construção.

3. **`WITH CHECK`, não só `USING`.** Sem ele um tenant grava no espaço do outro
   e perde a linha de vista em seguida. É pior que ler: a escrita "funciona" e o
   dado some.

## O que falta para ligar em produção

1. Trocar `DATABASE_URL` para `app_rw` e dar `LOGIN` + senha ao papel.
2. Apontar os jobs globais de §8.8 — partições, câmbio, retenção, reaper — para
   `app_maintenance`. Eles atravessam tenants **por desenho**, e sob `app_rw`
   fariam trabalho nenhum, em silêncio.
3. Estender as políticas às demais tabelas de inteligência (`ads`, `ad_scores`,
   `recommendations`, `recommendation_outcomes`, `ad_actions`,
   `action_executions`). O mecanismo está provado; o resto é mecânico.
4. Rodar `pnpm bench:ads` **depois** de ligar: cada consulta passa a ser
   `BEGIN; SET LOCAL; …; COMMIT`, e o orçamento de §17.2 tem folga de uma ordem
   de grandeza (33 ms contra 400) — mas folga presumida não é folga medida.
5. Resolver as quatro tabelas com `organization_id` nullable, abaixo, ou
   declará-las permanentemente fora da política.

---

## O registro da avaliação original

O que segue é a análise de 2026-08-03, preservada: ela continua sendo a
descrição correta do **custo** de ativar RLS, e é o que a conformidade decidiu
pagar.

---

## O que já existe

| Camada | O que garante | Onde |
|---|---|---|
| `organizationId NOT NULL` denormalizado | toda tabela de inteligência carrega o tenant na própria linha, sem join | `schema.prisma` — `ads`, `ad_scores`, `waste_items`, `recommendations`, `recommendation_outcomes`, `ad_actions`, `action_executions`, `ad_metric_snapshots` |
| `OrganizationAccessGuard` + `X-Organization-Id` | nenhuma rota de inteligência responde sem organização resolvida | `organizations/infrastructure/http/guards/` |
| Escopo obrigatório no repositório | toda consulta carrega `organizationId` no `where` | verificado em `test/architecture/` |
| `OwnerScopeResolverService` | a organização vem do vínculo do usuário, nunca do corpo da requisição | `integrations/application/services/` |

A quarta linha é a que mais importa e é a menos citada: **o `organizationId`
nunca vem do cliente**. Ele é resolvido a partir do vínculo do usuário
autenticado. RLS protege contra uma consulta que esqueceu o filtro; não protege
contra um filtro construído a partir de um valor errado, e é esse o modo de
falha que a resolução por vínculo elimina.

---

## Por que não agora

### 1. A pré-condição não está completa

RLS exige `organizationId NOT NULL` em **toda** tabela sob a política. Quatro
tabelas ainda o têm nullable, e cada uma por uma razão viva:

| Tabela | Por que é nullable | O que RLS exigiria |
|---|---|---|
| `audit_logs` | eventos de conta (`account.created`, `account.deleted`) acontecem **antes** de haver organização | uma política com `IS NULL` de exceção — que é um buraco na política, não uma política |
| `security_audit_logs` | tentativa de login falhada não tem organização por definição: não se sabe quem é | idem |
| `reports` | herdado do v1; A2-S9 passou a **recusar** geração sem organização, mas as linhas antigas ficam | backfill ou expurgo do histórico |
| `detector_profiles` | perfil global é o padrão do produto, e o `null` é o que o torna global | política com exceção por valor |

Ativar RLS com exceções `IS NULL` produz uma política que, lida em voz alta, diz
*"isole por organização, exceto quando não houver uma"* — e a primeira linha que
perder o `organizationId` por bug passa a ser visível para todos os tenants,
silenciosamente. É pior que não ter RLS: cria a confiança sem a garantia.

### 2. Um papel de banco só

A aplicação conecta com um papel único, e o mesmo papel roda migrações. RLS sob
`BYPASSRLS` — que o dono das tabelas tem por padrão — não faz nada; RLS sem
`BYPASSRLS` quebra as migrações e os jobs globais (partições, câmbio, retenção),
que legitimamente atravessam tenants.

Fazer certo exige **dois papéis** (`app_rw` sem bypass, `app_migrator` com), o
`SET LOCAL app.organization_id` por transação, e um ponto único onde ele é
setado. Com o Prisma, esse ponto único não existe hoje: as transações são
abertas em ~20 repositórios diferentes.

### 3. Os jobs não têm organização

Câmbio, partições, retenção e o reaper de execuções são **globais por desenho**
(§8.8, `scopeType: 'GLOBAL'`). Sob RLS, cada um precisaria de bypass explícito —
e um bypass concedido a um worker é um bypass que existe no processo que roda o
código menos revisado do sistema.

### 4. O custo cai sobre o gate que mais protege hoje

`test/architecture/application-graph.spec.ts` monta o grafo inteiro sem tocar em
Postgres, e é ele que pega "compila mas não sobe" desde A2-S2. Os testes de
integração que existem (`test/integration/`) rodam contra o banco real com o
papel do dono. Ativar RLS os quebraria todos de uma vez, e a saída fácil —
rodá-los com bypass — os faria deixar de exercitar a política que se acabou de
ativar.

---

## O que muda agora

**Um gate de schema novo**, para que a pré-condição de RLS não se degrade em
silêncio enquanto a decisão está adiada:

- toda tabela de **inteligência** (`ads`, séries, achados, recomendações,
  outcomes, ações, execuções) tem `organization_id NOT NULL`;
- a lista de exceções é **fechada e nomeada** — as quatro acima —, e uma tabela
  nova que nasça com `organization_id` nullable quebra o build.

Está em [`test/architecture/schema-gates.spec.ts`](../test/architecture/schema-gates.spec.ts)
como `G16`.

O ganho é o que R9 pede de verdade: a mitigação declarada em §18 é
*"`organizationId NOT NULL` denormalizado em tudo"*, e até aqui isso era uma
afirmação sobre o schema que ninguém verificava.

---

## Os gatilhos, e qual disparou

Três foram escritos. **O segundo ocorreu em 2026-08-04**, um dia depois:

1. **Um segundo consumidor do banco** — BI, réplica de leitura para relatórios,
   qualquer processo que não passe pelos repositórios da aplicação. É o momento
   em que a tenancy deixa de ser garantida por código que revisamos.
2. **← ESTE.** Exigência de conformidade contratual que peça isolamento no
   nível do armazenamento (SOC 2 Type II com escopo de multi-tenancy, ou cliente
   enterprise com auditoria própria).
3. **Uma regressão de tenancy real em produção** — o cenário que R9 nomeia. Se
   acontecer uma vez, o custo das três objeções acima passa a ser menor que o do
   próximo incidente.

O caminho estava escrito para não ser redescoberto — e foi ele que A2-S9
executou, nesta ordem:

1. `app_rw` sem `BYPASSRLS`, `app_migrator` com;
2. `SET LOCAL app.organization_id` num **middleware de transação** do Prisma, não
   em cada repositório;
3. RLS primeiro em `ad_metric_snapshots` e `waste_items` — as duas maiores e as
   duas sem exceção de `null`;
4. os testes de integração passam a rodar com `app_rw`, e um teste novo prova que
   uma consulta **sem** `SET LOCAL` devolve zero linhas;
5. as quatro tabelas de exceção entram por último, depois de o `null` ter sido
   resolvido em cada uma — ou ficam permanentemente fora, o que é uma decisão
   legítima para trilha de auditoria de eventos pré-organização.
