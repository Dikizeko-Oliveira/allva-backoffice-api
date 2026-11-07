# allva-backoffice-api — Gaps da auditoria de prontidão do Beta

> Gaps encontrados neste repositório pela auditoria de prontidão do Beta (iniciada em 2026-11-03).
> **Índice consolidado, placar, bloqueadores, pendências externas e plano de correção:** `../audit/gaps.md` (diretório compartilhado dos quatro repositórios).
> Os IDs (`GAP-nnn`) são globais e únicos entre os quatro repositórios.
>
> **Flag de beta, no título de cada gap:**
> - `[BLOQUEIA-BETA]` — precisa estar resolvido (e validado) antes de liberar os beta users.
> - `[CONDICIONAL-BETA]` — bloqueia só se um risco não for aceito por escrito ou uma configuração não for confirmada.
> - sem flag — não impede o início do Beta.
>
> Encontrar todos: `grep -n "BLOQUEIA-BETA\|CONDICIONAL-BETA" docs/gaps.md`
>
> **Regras:** um gap nunca é apagado; muda de status com data e evidência. Código alterado não é gap resolvido: `RESOLVIDO` exige a evidência da validação. Nenhum segredo, token ou dado pessoal é transcrito aqui.

**Natureza:** `CONFIRMADO` (evidência no código ou em execução) · `RISCO` (mecanismo existe; impacto depende de condição externa) · `A VALIDAR` (depende de ambiente, terceiro ou teste dinâmico)
**Status:** `ABERTO` · `EM CORREÇÃO` · `CORRIGIDO — A VALIDAR` · `RESOLVIDO` · `ACEITO (risco assumido)` · `DESCARTADO` (com motivo)

---

## Gaps deste repositório

---

#### GAP-042 — Dependências HTTP vulneráveis sem `pnpm.overrides` (1 crítico, 42 altos) `[BLOQUEIA-BETA]`

> **Beta:** `BLOQUEIA-BETA` — a API do backoffice responde sem autenticação em api-backoffice.allva.com.br, na mesma VPS do produto; um DoS nela (multer, path-to-regexp, body-parser) derruba CPU e memória que o produto divide. A correção é copiar os overrides que o allva-api já usa.

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` |
| Arquivo | `package.json` (sem bloco `pnpm.overrides`) |
| Categoria | Dependências / Segurança |
| Severidade | **HIGH** |
| Natureza | **CONFIRMADO** (`pnpm audit --prod`, 2026-11-04, commit `e440d8b`: 1 crítico, 42 altos) |
| Status | **CORRIGIDO — A VALIDAR** — 2026-11-06 (`d812100`) |
| Fase | BOA-1 |

**Descrição.** A correção SEC-03 da auditoria de segurança (out/2026) fixou versões seguras no `allva-api` via `pnpm.overrides`, mas nunca chegou a este repositório. Ficaram na árvore de produção, no caminho de toda requisição HTTP:

| Pacote | Versão instalada | Corrigido em | Efeito |
|---|---|---|---|
| `proxy-addr` | 2.0.7 | ≥ 2.0.8 | **crítico** — falsificação de IP (afeta `req.ip`, o throttle e o `ip` da auditoria) |
| `multer` | 2.0.2 | ≥ 2.5.0 | vários DoS por multipart |
| `path-to-regexp` | 8.3.0 | ≥ 8.4.0 | DoS por rota com regex catastrófica |
| `body-parser` | 2.2.2 | ≥ 2.4.0 | DoS no parse do corpo |
| `lodash` | 4.17.21 / 4.17.23 | ≥ 4.18.0 | prototype pollution |
| `@nestjs/core` | 11.1.13 | (subir junto) | |

**Comportamento atual.** Qualquer cliente na internet alcança o parser antes do `AuthGuard`. **Esperado.** Mesma política de dependências do `allva-api`.

**Impacto.** O backoffice e o produto rodam na **mesma VPS** (GAP-001): exaustão de CPU ou memória aqui degrada o produto dos beta users.

**Solução recomendada.** Copiar os overrides do `allva-api` (`multer@<2.3.0 → 2.4.0`, `path-to-regexp@>=8.0.0 <8.4.0 → 8.4.2`, `proxy-addr@<2.0.8 → 2.0.8`, `qs@<6.16.0 → 6.16.1`, `body-parser@>=2.0.0 <2.3.0 → 2.3.0`, `lodash@<4.18.0 → 4.18.1`), revisar os pisos com o relatório atual do `pnpm audit` (o multer pede ≥ 2.5.0), subir `@nestjs/*` para a mesma linha do `allva-api`, rodar `pnpm install`, `typecheck`, `test` e `build`.

**Critério de aceite.** `pnpm audit --prod` sem crítico e sem alto no caminho HTTP; suítes verdes; imagem reconstruída e no ar na VPS.

**Atualização 2026-11-06: corrigido em `d812100`.** O `pnpm.overrides` do `allva-api` foi copiado, e `@nestjs/*` subiu para 11.1.29 e `zod` para 4.6.7. O `pnpm audit --prod` caiu de 1 crítico e 42 altos para **0 críticos e 30 altos**; os altos que sobram são de ferramenta, fora do caminho de requisição. A flag fica até a VPS rodar a versão nova.

---

#### GAP-043 — Conversão de minuta em contrato pode criar contrato duplicado ou órfão

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` (+ `allva-api`) |
| Arquivo | `src/modules/contract-drafts/application/use-cases/convert-contract-draft.usecase.ts`; `allva-api/src/modules/contracts/infrastructure/http/controllers/admin-contracts.controller.ts:76` |
| Categoria | Integridade / Idempotência |
| Severidade | **MEDIUM** |
| Natureza | **CONFIRMADO** (leitura do código) |
| Status | **CORRIGIDO — A VALIDAR** — 2026-11-06 (`allva-api@092e5ae`, `cc3190d`) |
| Fase | BOA-3 |

**Descrição.** A conversão lê a minuta, chama `POST /api/v1/admin/contracts` no `allva-api` e só depois grava `markConverted`. A idempotência prometida no comentário ("um duplo clique não cria dois contratos") vale só para chamadas em série:

1. **Concorrência:** duas requisições simultâneas leem `isConverted = false` e criam dois contratos. O `update` da minuta é `where: { id }`, sem condição de estado.
2. **Falha parcial:** se o `allva-api` cria o contrato e a resposta não chega (timeout do `AllvaApiClient`) ou o `update` local falha, a minuta continua não convertida e a nova tentativa cria outro contrato. O primeiro fica órfão.
3. A rota do `allva-api` não aceita `Idempotency-Key`, então o lado do produto não tem como deduplicar.

**Impacto.** Contrato enterprise duplicado na carteira do operador, com risco de fatura duplicada se ambos forem ativados. A operação é rara e feita por operador, por isso fica em MEDIUM.

**Solução recomendada.** Enviar um `Idempotency-Key` derivado do id da minuta e fazer o `allva-api` respeitá-lo na criação, como já faz nas ações sensíveis. Do lado de cá, marcar a minuta como `CONVERTING` com um update condicional (`where: { id, convertedAt: null }`) antes de chamar o produto.

**Critério de aceite.** Um teste com duas conversões concorrentes da mesma minuta produz um único contrato, e uma nova tentativa depois de um timeout devolve o mesmo `contractId`.

**Atualização 2026-11-06: corrigido nos dois lados.**
- **`allva-api@092e5ae`:** `POST /admin/contracts` aceita `Idempotency-Key`. A chave e o dígito do corpo ficam em `enterprise_contracts` (`creation_key` único, `creation_digest`; migration aditiva `20261106120000`, já aplicada no `allva_db` local). O mesmo pedido devolve o mesmo contrato, e a mesma chave com outro corpo dá `409 IDEMPOTENCY_KEY_REUSED`. A corrida que perde na unicidade de `contract_number` também é reconhecida. A criação foi para o `CreateContractUseCase`.
- **`cc3190d`:** a conversão manda `contract-draft:<id>` e grava a minuta só se ainda não tem contrato; só a primeira conversão audita.

**Testes:** unitários dos dois lados (série, paralelo, falha local e corpo diferente) e de integração contra Postgres (`allva-api`: dois `INSERT` simultâneos com a mesma chave dão um contrato; backoffice: duas gravações dão uma vitória).

**Ordem de deploy:** o `allva-api` primeiro. Um `allva-api` antigo ignora o header, e o comportamento volta ao anterior.

---

#### GAP-044 — SLA só é recalculado na leitura; escalonamento e alertas nunca disparam (0 jobs) `[CONDICIONAL-BETA]`

> **Beta:** `CONDICIONAL-BETA` — se o suporte for o canal do beta, nenhum operador é avisado de chamado estourando o SLA; aceitar que a fila seja olhada manualmente ou implementar o job antes.

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` (+ `allva-backoffice-web`) |
| Arquivo | `src/modules/support/application/ticket-sla-tracker.service.ts` (chamado só por `list-support-queue`, `get-support-ticket` e `assign-support-ticket`); `src/modules/alerts/` |
| Categoria | Funcionalidade incompleta / Operação |
| Severidade | **MEDIUM** |
| Natureza | **CONFIRMADO** (`grep @Cron/@Interval/setInterval` = 0 no repositório; item herdado H-20) |
| Status | ABERTO (parcial) — 2026-11-06 (`7e4604c`) |
| Fase | BOA-2 / BOA-3 |

**Descrição.** O backoffice tem políticas de SLA, regras de alerta com CRUD auditado e campos `escalatedAt`. Não há nenhum agendador no processo:

- O snapshot de SLA só é atualizado quando alguém **abre** a fila ou o chamado. Um chamado que ninguém olha nunca fica "vencido" no banco.
- `escalatedAt` é lido pelo presenter, mas nenhum caminho o escreve.
- As regras de alerta são cadastradas e editadas, mas nenhum avaliador gera `alert_events`. A tela de alertas fica sempre vazia.

**Comportamento esperado.** Ou um job periódico recalcula o SLA, escala e gera eventos de alerta, ou as telas deixam claro que o recurso não está ativo.

**Impacto.** O operador confia num alerta que não existe. Com o beta usando o suporte, um chamado parado não avisa ninguém.

**Solução recomendada.** Criar um job (cron a cada 5 min, com lease para não rodar duas vezes) que chama o `TicketSlaTrackerService` sobre os chamados abertos e avalia as regras de alerta. Enquanto ele não existir, marcar alertas e escalonamento como "não ativo" no painel.

**Critério de aceite.** Um chamado sem leitura passa de `ON_TRACK` para `BREACHED` sozinho, e uma regra de alerta ativa gera um evento visível no painel.

**Atualização 2026-11-06: parte local entregue em `7e4604c`.**

**O que o job faz.** A cada 5 min, o `AlertEvaluationScheduler` avalia as regras ativas sobre os sinais de atendimento deste banco (`support.sla_breached`, `sla_at_risk`, `escalated`). Usa as mesmas contagens do hub, e o limiar aceita `>= N`, `> N` e `== N`. Acima do limiar e sem evento aberto, grava um `alert_event`, que aparece no painel e em `alerts.unacknowledged`. O evento aberto deduplica até alguém reconhecê-lo. `ALERT_EVALUATION_ENABLED=false` desliga o job. Coberto por testes unitários e por um teste de integração em que a regra gera o evento uma vez.

**O que segue aberto:**
- sinais do produto e chamados que o backoffice nunca observou, que precisam da conta de serviço no `allva-api` (`docs/backoffice-api.md` §6). É uma mudança no RBAC de plataforma e **pede decisão do dono**;
- escalonamento, porque não há destino configurado;
- envio por canal e `quiet_hours`.

Um chamado já observado passa de `ON_TRACK` a `BREACHED` sozinho, porque o estado é calculado contra o relógio. Um nunca observado não passa.

---

#### GAP-045 — Atribuição de chamado sem reconciliação quando a gravação local falha

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` |
| Arquivo | `src/modules/support/application/use-cases/assign-support-ticket.usecase.ts:61-86` |
| Categoria | Integridade |
| Severidade | **LOW** |
| Natureza | **CONFIRMADO** (código + `docs/MEMORY.md:182`, `[VERIFY]` não resolvido; item herdado H-20) |
| Status | **CORRIGIDO — A VALIDAR** — 2026-11-06 (`1934b80`) |
| Fase | BOA-3 |

**Descrição.** A atribuição é gravada primeiro no `allva-api` e depois, aqui, o evento de repasse, o SLA e a auditoria. Se a gravação local falha, o operador recebe erro, mas a atribuição já valeu no produto. O repasse fica sem motivo registrado e sem linha na auditoria do backoffice, e nada reconcilia. Além disso, o motivo obrigatório é decidido sobre um `get` anterior ao `assign`, sem checar se o responsável mudou nesse intervalo.

**Solução recomendada.** Gravar o evento como `PENDING` antes de chamar o produto e confirmá-lo depois, com uma varredura que reconcilia os pendentes. Ou, no mínimo, registrar a falha em log estruturado com o `ticketId`.

**Critério de aceite.** Um teste que derruba a gravação local depois do `assign` deixa um rastro recuperável.

**Atualização 2026-11-06: corrigido em `1934b80`.** A auditoria (de → para, motivo) é gravada logo depois do `assign` no produto. Uma falha no evento de repasse ou no SLA loga `support.assignment_local_write_failed` com `ticketId`, `from`, `to` e `actorId`, e depois sobe. O teste do critério derruba a gravação local depois do `assign`, e o rastro fica. **Segue em aberto:** a corrida do responsável entre o `get` e o `assign` precisa de atribuição condicional no `allva-api`.

---

#### GAP-046 — Auditoria do backoffice grava `ip` e `userAgent` só na atribuição de chamado (1 de 16 escritores)

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` |
| Arquivo | 16 chamadas a `BackofficeAuditLogService.record` em `src/modules/*/application/use-cases/`; só `assign-support-ticket.usecase.ts` recebe `RequestOrigin` |
| Categoria | Auditoria |
| Severidade | **LOW** |
| Natureza | **CONFIRMADO** (grep) |
| Status | **CORRIGIDO — A VALIDAR** — 2026-11-06 (`2ae71b5`) |
| Fase | BOA-1 |

**Descrição.** Criar ou converter minuta de contrato, mudar política de SLA, criar ou excluir nota interna e cadastrar regra de alerta são auditados com `ip = null` e `userAgent = null`. A tela de auditoria exibe essas colunas vazias. Uma investigação de uso indevido de conta de operador fica sem a origem.

**Solução recomendada.** Resolver a origem uma vez (interceptor ou `AsyncLocalStorage` com `clientIp(req)`, que já existe em `src/shared/infrastructure/http/client-ip.ts`) e preenchê-la no `BackofficeAuditLogService`, em vez de passá-la por cada use case. Depende do GAP-042 (`proxy-addr`), porque com IP falsificável a coluna não é confiável.

**Critério de aceite.** Toda linha nova de `backoffice_audit_logs` vinda de requisição HTTP tem `ip` e `userAgent`.

**Atualização 2026-11-06: corrigido em `2ae71b5`.** O `CorrelationIdMiddleware` guarda o IP provado (GAP-033) e o `User-Agent`, até 512 caracteres, no contexto da requisição. O `BackofficeAuditLogService` preenche os dois em toda escrita. A atribuição parou de passar `request.ip`, que não é o IP provado. Coberto por teste unitário. Fora de requisição, os dois ficam nulos.

---

#### GAP-047 — Vocabulário de permissões de plataforma defasado do `allva-api` (faltam `beta:*` e `usage:*`)

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` (+ `allva-backoffice-web`) |
| Arquivo | `src/modules/auth/domain/platform-permissions.ts` (25 permissões) × `allva-api/src/modules/accounts/domain/platform-rbac.ts` (28) |
| Categoria | Autorização / Consistência |
| Severidade | **LOW** |
| Natureza | **CONFIRMADO** (comparação dos dois catálogos, 2026-11-04) |
| Status | **CORRIGIDO — A VALIDAR** — 2026-11-06 (`410402b`) |
| Fase | BOA-4 |

**Descrição.** O catálogo é espelhado à mão ("permissão nova nasce no `allva-api` primeiro, e só depois entra aqui"). Os programas beta (B1–B5) e o painel de custo adicionaram `beta:read`, `beta:manage`, `usage:read` e `usage:manage` no `allva-api`, e o espelho não foi atualizado. A autorização em tempo de execução não é afetada, porque a lista não filtra `Operator.permissions`. Mas `@IsIn(PLATFORM_PERMISSIONS)` nos DTOs de nota interna e de regra de alerta recusa (400) uma nota ou alerta restrito a essas permissões, e nenhum teste detecta a divergência.

**Solução recomendada.** Adicionar as 4 permissões e um teste de paridade que compara com uma cópia versionada do catálogo do `allva-api`, ou gerar o arquivo a partir dele.

**Critério de aceite.** Os dois catálogos têm as mesmas 28 permissões e um teste falha quando divergem.

**Atualização 2026-11-06: corrigido em `410402b`.** As 4 permissões entraram no catálogo, que agora tem as mesmas 28 do `allva-api`. O gate `platform-permissions-parity.spec.ts` compara o catálogo com uma cópia versionada. Com o repositório irmão ao lado, ou com `ALLVA_API_DIR`, compara também essa cópia com o arquivo do `allva-api`. **Falta:** o espelho do `allva-backoffice-web`.

---

#### GAP-048 — Sem nenhum teste de integração contra Postgres no backoffice-api

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` |
| Arquivo | `test/` (só `architecture/` e `support/`); `package.json` sem script `test:integration` |
| Categoria | Testes |
| Severidade | **MEDIUM** |
| Natureza | **CONFIRMADO** (`pnpm test`, 2026-11-04: 12 suítes, 53 testes, todas unitárias ou de arquitetura) |
| Status | **CORRIGIDO — A VALIDAR** — 2026-11-06 (`b7342bc`) |
| Fase | BOA-5 |

**Descrição.** Os 9 repositórios Prisma (auditoria, SLA, notas, alertas, minutas, preferências, eventos de atribuição) nunca são exercitados contra um banco. Paginação, filtros da auditoria (um defeito de filtro já foi corrigido em 23/09), unicidade de visão salva e o `update` sem condição do GAP-043 não têm cobertura. A migração inicial também nunca rodou num banco gerenciado (H-21), e esse item ficou obsoleto com a saída do Cloud SQL.

**Solução recomendada.** Adicionar `test:integration` com `REQUIRE_DATABASE=true` no mesmo molde do `allva-api`, cobrindo ao menos auditoria (filtros e paginação), conversão de minuta e atribuição. Rodar `prisma migrate deploy` num banco vazio como primeiro teste.

**Critério de aceite.** Uma suíte de integração roda verde contra um Postgres local e entra no CI.

**Atualização 2026-11-06: corrigido em `b7342bc`.** `pnpm test:integration` roda sobre um banco **dedicado** (`INTEGRATION_DATABASE_URL`) e recusa um banco cujo nome não tenha `test`, `integration` ou `ci`. O `globalSetup` aplica `migrate deploy`. A suíte cobre:
- migrações do zero;
- filtros e paginação da auditoria;
- conversão condicional de minuta;
- contagens do hub com a janela proporcional;
- regra de alerta que vira evento.

**4 suítes e 8 testes verdes** contra um banco novo no container local (`allva_backoffice_integration`). A suíte entrou no job de migrações do CI; a primeira run no GitHub valida.

---

#### GAP-049 — CORS, `/docs` e SSL do banco dependem de variáveis não confirmadas na VPS

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` |
| Arquivo | `src/configure-app.ts:84-100` (CORS); `src/shared/infrastructure/database/prisma/prisma.service.ts:14-18` (SSL) |
| Categoria | Configuração / Segurança |
| Severidade | **LOW** |
| Natureza | **A VALIDAR** (depende do ambiente da VPS) |
| Status | ABERTO (parcial) — 2026-11-06 (`56550bf`) |
| Fase | BOA-1 |

**Descrição.** O mesmo padrão do GAP-011, no backoffice:

- Fora de `NODE_ENV=production`, o CORS aceita **qualquer** origem com `credentials: true`, e a documentação fica exposta. O `Dockerfile` define `NODE_ENV=production`. Se a VPS sobe o processo sem a imagem (pm2 ou `node dist/main` com o `.env`, cujo exemplo traz `development`), as duas proteções caem.
- O SSL do banco é opt-in (`DATABASE_SSL === 'true'`). Sem a variável, a conexão é em texto puro. Isso é aceitável se o Postgres está no mesmo host, mas é um vazamento se ele estiver em outro.
- `TRUSTED_PROXIES` vem vazio no exemplo. Atrás do proxy reverso da VPS, todo `req.ip` vira o IP do proxy (o mesmo efeito do GAP-033).

**Solução recomendada.** Confirmar na VPS `NODE_ENV=production`, `TRUSTED_PROXIES` com o proxy local e `DATABASE_SSL=true` se o banco não for local. Idealmente, falhar o boot quando `NODE_ENV` não for `production` e o host não for local.

**Critério de aceite.** `curl -H 'Origin: https://evil.example' -I https://api-backoffice.allva.com.br/api/v1/health` não devolve `Access-Control-Allow-Origin`, e `/docs` responde 404.

**Atualização 2026-11-04 (fase EXT, leitura passiva da produção).** Em `https://api-backoffice.allva.com.br`: `/docs` e `/docs-json` → 404 ✓, e o CORS não devolve `Access-Control-Allow-Origin` para origem estranha ✓. O preflight `OPTIONS` com `Origin: https://evil.example` responde **500**, e não 403. O callback do CORS lança `new Error(...)`, que o Nest converte em erro interno. O efeito é ruído de 500 nos logs e nos alertas a cada sonda, sem exposição. Correção: responder `callback(null, false)`, como faz o `allva-api`.

**Atualização 2026-11-06: parte de código em `56550bf`.** A origem recusada pelo CORS responde `403 CORS_ORIGIN_NOT_ALLOWED`, e não 500. **Falta**, a cargo do dono na VPS: `NODE_ENV=production`, `TRUSTED_PROXIES`, `TRUSTED_CLIENT_IP_SECRET` e `DATABASE_SSL`, se o banco não for local.

---

#### GAP-050 — Documentação do backoffice-api divergente do código (SSL, deploy no GCP, Cloud SQL)

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` |
| Arquivo | `docs/MEMORY.md:187`; `docs/ARCHITECTURE.md:224`; `.github/workflows/deploy.yml` |
| Categoria | Documentação |
| Severidade | **INFO** |
| Natureza | **CONFIRMADO** |
| Status | **CORRIGIDO** — 2026-11-06 (`80e4065`) |
| Fase | BOA-4 |

**Descrição.** O `MEMORY.md` e o `ARCHITECTURE.md` dizem que o `PrismaService` usa `rejectUnauthorized: false` para qualquer URL fora de `localhost`. O código atual faz SSL opt-in por `DATABASE_SSL` e, quando ligado, **verifica** o certificado (`rejectUnauthorized: true`). O item herdado H-20 sobre SSL fica, portanto, superado. O deploy documentado e o workflow apontam para o Cloud Run e o Cloud SQL, que foram cancelados (GAP-001), e o H-21 (migração como não-superusuário no Cloud SQL) perdeu o objeto.

**Solução recomendada.** Atualizar as duas passagens sobre SSL, registrar no `MEMORY.md` a topologia da VPS e marcar o H-21 como obsoleto.

**Critério de aceite.** Nenhum documento do repositório descreve um comportamento de SSL ou de deploy que o código não tem.

**Atualização 2026-11-06: corrigido em `80e4065`.** A documentação de SSL e de deploy foi alinhada ao código, e o Cloud SQL saiu do texto. O `deploy.yml` do GCP está desligado e fica no repositório, sem efeito.

---

#### GAP-059 — Chamado HIGH ou CRITICAL já nasce "em risco": janela fixa de 2 h ≥ prazo do SLA

| Campo | Valor |
|---|---|
| Repositório | `allva-backoffice-api` |
| Arquivo | `src/modules/support/domain/sla.ts:10` (`SLA_AT_RISK_WINDOW_MS = 2 h`), `:28-33` (`FALLBACK_SLA_TARGETS`) |
| Categoria | Regra de negócio |
| Severidade | **LOW** |
| Natureza | **CONFIRMADO** (teste local, 2026-11-04: chamado HIGH aberto pelo cliente às 13:30 já aparece `AT_RISK` com vencimento às 15:30) |
| Status | **CORRIGIDO — A VALIDAR** — 2026-11-06 (`c87cc56`) |
| Fase | TR |

**Descrição.** O estado `AT_RISK` vale quando faltam até 2 h para o vencimento. A primeira resposta de HIGH tem prazo de 2 h e a de CRITICAL de 30 min. Esses chamados passam direto de criados para "em risco", e o filtro `/support?sla=AT_RISK` do painel deixa de separar o que está realmente perto de estourar.

**Solução recomendada.** Janela proporcional ao prazo (por exemplo, os últimos 25 %, com um mínimo de 10 minutos), ou uma janela configurável por política.

**Critério de aceite.** Um chamado HIGH recém-aberto aparece `ON_TRACK` e passa a `AT_RISK` só perto do vencimento; o teste unitário de `sla.ts` cobre as quatro prioridades.

**Atualização 2026-11-06: corrigido em `c87cc56`.** A janela de risco é a última quarta parte do prazo, entre 10 min e 2 h. Um HIGH novo fica no prazo e entra em risco nos últimos 30 min da primeira resposta. Um CRITICAL entra nos últimos 10 min. Os prazos longos não mudaram. A regra mora em `pendingDeadlinesOf` e `slaStateOf`, e vale igual para a fila e para o hub. O hub busca os candidatos no horizonte de 2 h e decide pela função pura. O teste cobre as quatro prioridades; o de integração cobre o HIGH novo e o que está perto do prazo.

---

## Gaps de outros repositórios que também afetam este

#### GAP-001 — Pipeline de deploy quebrado na autenticação GCP (WIF) nos três repositórios que tentaram deployar

> Registro completo em `allva-api/docs/gaps.md`. Este repositório também é afetado. Severidade: INFO. Status: ABERTO — 2026-11-03.

#### GAP-002 — Não existe ambiente de produção separado; os quatro serviços deployam em `allva-staging`

> Registro completo em `allva-api/docs/gaps.md`. Este repositório também é afetado. Severidade: INFO (provisória até Q1). Status: ABERTO — 2026-11-03.

#### GAP-003 — O código auditado (`development`) não é o código em execução `[CONDICIONAL-BETA]`

> Registro completo em `allva-api/docs/gaps.md`. Este repositório também é afetado. Severidade: MEDIUM. Status: ABERTO — 2026-11-03.

#### GAP-005 — Documentação divergente do código em pontos que guiam decisões

> Registro completo em `allva-api/docs/gaps.md`. Este repositório também é afetado. Severidade: LOW. Status: ABERTO — 2026-11-03.

#### GAP-055 — KPIs e exportações truncam em 5 000 linhas sem avisar

> Registro completo em `allva-backoffice-web/docs/gaps.md`. Este repositório também é afetado. Severidade: LOW. Status: ABERTO.

#### GAP-058 — `X-Correlation-Id` atravessa os quatro serviços, mas não é gravado em nenhum log

> Registro completo em `allva-api/docs/gaps.md`. Este repositório também é afetado. Severidade: MEDIUM. Status: ABERTO.
