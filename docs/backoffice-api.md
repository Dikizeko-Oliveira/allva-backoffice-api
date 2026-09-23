# `allva-backoffice-api` — o que ele precisa ter e fazer

Especificação para quem vai implementar o backend próprio do backoffice.
Escrita a partir de `docs/workspace-screen.md` (o Operations Hub) e do estado
real do `allva-api` em 22/09/2026.

O backoffice tem **três peças**, e cada decisão abaixo depende de saber de qual
delas ela é:

| Peça | É dona de | Não é dona de |
|---|---|---|
| `allva-api` | O produto: organizações, contas, contratos, faturas, assinaturas, integrações, jobs, leads, contatos, chamados. **E a matriz de papéis e permissões de plataforma** (`src/modules/accounts/domain/platform-rbac.ts`). | Como a Allva se organiza para atender. |
| `allva-backoffice-api` | O **processo interno** da Allva: fila e SLA de atendimento, anotações de operador, visões salvas, alertas internos, minutas pré-assinatura, métricas de atendimento. | Qualquer dado do produto, e qualquer decisão de permissão. |
| `allva-backoffice-web` | Navegação: áreas (workspaces), sidebar, hub, guardas de tela. | Autorização final — ela só melhora a experiência. |

O critério para decidir onde algo mora: **se o cliente da Allva deixasse de
existir amanhã, o dado ainda faria sentido?** Se só faz sentido para o time da
Allva (quem atendeu, quanto demorou, o que foi anotado), é do
`allva-backoffice-api`. Se descreve o cliente ou o que ele contratou, é do
`allva-api`. Colocar processo interno no `allva-api` acoplaria o produto ao
modo de trabalhar do time: mudar a regra de escalonamento passaria a exigir
migração no banco do cliente.

---

## 1. Papéis e permissões — o que já existe e não deve ser duplicado

### 1.1 Os papéis atuais

São cinco, e são **faixas paralelas, não degraus**. Só `ALLVA_ADMIN` está
acima de todos, e mesmo ele recebe as permissões por enumeração.

| Papel | Rótulo | Área |
|---|---|---|
| `ALLVA_ADMIN` | Administração | Tudo, incluindo configurações e concessão de papéis |
| `ALLVA_OPERATOR` | Operações | Sincronizações, integrações, saúde da plataforma, auditoria |
| `ALLVA_SUPPORT` | Suporte | Atendimento, contatos, consulta de contas |
| `ALLVA_FINANCE` | Financeiro | Faturas, contratos, assinaturas, limites contratados |
| `ALLVA_SALES` | Comercial | Pipeline de leads |

Conta de cliente tem papel `USER` e **nenhuma** permissão de plataforma.
Uma conta tem **um** papel (`Account.role`); papel duplo exigiria tabela de
associação no `allva-api` e é decisão em aberto (§8).

### 1.2 As permissões

A matriz é esta, e mora no `allva-api`:

| Permissão | ADMIN | OPERATOR | SUPPORT | FINANCE | SALES |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `orgs:read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `orgs:manage` | ✓ | | | | |
| `orgs:quota_manage` | ✓ | | | ✓ | |
| `users:read` | ✓ | | ✓ | ✓ | |
| `users:manage` | ✓ | | | | |
| `users:manage_platform_role` | ✓ | | | | |
| `leads:read` / `leads:manage` | ✓ | | | | ✓ |
| `support:read` / `support:manage` | ✓ | | ✓ | | |
| `contacts:read` / `contacts:manage` | ✓ | | ✓ | | |
| `subscriptions:read` | ✓ | | ✓ | ✓ | |
| `subscriptions:manage` | ✓ | | | ✓ | |
| `billing:read` / `billing:manage` | ✓ | | | ✓ | |
| `integrations:read` | ✓ | ✓ | ✓ | | |
| `integrations:manage` | ✓ | ✓ | | | |
| `operations:read` / `operations:execute` | ✓ | ✓ | | | |
| `audit:read` | ✓ | ✓ | | | |
| `settings:read` / `settings:manage` | ✓ | | | | |

### 1.3 Adaptação dos nomes de `workspace-screen.md`

O documento de tela usa nomes ilustrativos. Os reais são os da matriz:

| Em `workspace-screen.md` | Permissão real |
|---|---|
| `organizations:read` / `organizations:write` | `orgs:read` / `orgs:manage` (e `orgs:quota_manage` para limite contratado) |
| `payments:read` / `payments:manage` | `billing:read` / `billing:manage` |
| `operations:execute`, `actions:execute`, `actions:execute_sensitive` | `operations:execute`. As `actions:*` são permissões **de organização** (cliente movendo o próprio anúncio), não de plataforma — não usar no backoffice. |
| `SUPER_ADMIN` | `ALLVA_ADMIN` |
| `FINANCE_ANALYST`, `SUPPORT_AGENT`, `OPERATIONS_MANAGER`… | Não existem. Quando existirem, nascem no enum do `allva-api` com linha na matriz — e nada neste documento muda, porque ninguém decide por papel. |

### 1.4 Regras que o `allva-backoffice-api` precisa seguir

1. **Não reimplementar a matriz.** O backoffice-api nunca lê `Account.role`
   nem tem uma cópia de `PLATFORM_ROLE_PERMISSIONS`. Ele recebe
   `platformPermissions` já resolvidas (§2) e decide por elas. Uma matriz
   copiada diverge na primeira permissão nova, e a divergência de uma guarda é
   silenciosa: o lado desatualizado continua respondendo `200`.
2. **Autorizar por permissão, nunca por papel.** `if (role === 'ALLVA_SUPPORT')`
   é recusado em revisão. A pergunta é sempre `can('support:manage')`.
3. **Permissão nova nasce no `allva-api`.** Se uma funcionalidade do
   backoffice-api precisar de uma capacidade que a matriz não tem (ex.:
   `support:assign`, separado de `support:manage`), ela é acrescentada
   primeiro em `platform-rbac.ts` — com a linha de cada papel e o teste de
   fronteira em `platform-rbac.spec.ts` — e só então usada aqui. O
   vocabulário é um só para as três peças.
4. **Fechar na dúvida.** Permissão ausente, `/auth/me` indisponível ou
   resposta inesperada ⇒ recusar (`403`, ou `503` se foi falha de
   dependência). Nunca "liberar enquanto o allva-api volta".
5. **Recusa declarada.** O corpo do `403` segue o formato do `allva-api`:
   `{ code: 'ACCOUNT_NOT_AUTHORIZED', message, details: { permission } }`. A
   tela usa `details.permission` para dizer ao operador o que faltou.

---

## 2. Autenticação: a identidade vem do `allva-api`

O operador faz login no `allva-api` (`POST /api/v1/auth/login`) e recebe o
bearer token. O backoffice-api **não emite** token nem guarda senha.

Para cada requisição, o backoffice-api precisa saber quem é o operador e o que
ele pode. A forma recomendada é **introspecção**:

```
GET {ALLVA_API_URL}/api/v1/auth/me
Authorization: Bearer <token do operador, repassado>
```

Resposta (campos relevantes):

```json
{
  "account": { "id": "…", "name": "João Silva", "email": "joao@allva.com" },
  "platformRole": "ALLVA_FINANCE",
  "platformPermissions": ["dashboard:read", "orgs:read", "billing:read", "…"]
}
```

- `platformRole: null` ⇒ conta de cliente ⇒ `403` em qualquer rota do
  backoffice-api.
- **Cache curto**, por token (ou pelo `sid` da sessão), de no máximo 60s.
  Validar o JWT localmente com a chave compartilhada seria mais rápido, mas
  perderia duas coisas que só o `allva-api` sabe: sessão revogada e troca de
  papel. Um operador rebaixado continuaria com o poder antigo até o token
  expirar (7 dias por padrão).
- Timeout de 2s na chamada; falha ⇒ `503`, não `401` (o operador não está
  deslogado, o serviço é que não conseguiu confirmar).
- O `account.id` é o identificador do operador em todas as tabelas do
  backoffice-api (`operator_id`, `author_id`, `assignee_id`…). Sem FK — é
  outro banco —, e sem copiar nome ou e-mail: exibição resolve pelo
  `allva-api` quando precisar.

---

## 3. O Operations Hub

A primeira tela depois do login, para todo operador, sem exceção
(`Login → /home → área`). Ela é montada pelo **backoffice-web** a partir de
três fontes (a primeira linha é identidade; as outras duas, pendências):

| O quê | De onde | Status |
|---|---|---|
| Nome, papel, permissões | `allva-api` — `GET /api/v1/auth/me` | **Existe** |
| Pendências do produto ("3 faturas vencidas", "2 integrações com erro") | `allva-api` — `GET /api/v1/admin/attention` | **Existe** |
| Números do Dashboard | `allva-api` — `GET /api/v1/admin/overview` | **Existe** |
| Pendências do processo interno ("4 chamados com SLA estourado") | `allva-backoffice-api` — `GET /api/v1/hub/attention` | **A criar** (§3.2) |
| Quais áreas e itens aparecem | registro de navegação do backoffice-web | É da web (§7) |

### 3.1 O que o `allva-api` já devolve em `GET /api/v1/admin/attention`

Qualquer papel de plataforma pode chamar; `USER` recebe `403`. Volta **só** o
que o operador pode ver — sinal de outra área não aparece nem zerado.

```json
{
  "generatedAt": "2026-09-22T21:04:00.000Z",
  "signals": [
    { "key": "billing.invoices_overdue", "permission": "billing:read", "severity": "CRITICAL", "count": 3 },
    { "key": "subscriptions.past_due", "permission": "subscriptions:read", "severity": "WARNING", "count": 0 },
    { "key": "subscriptions.trials_ending_soon", "permission": "subscriptions:read", "severity": "INFO", "count": null }
  ]
}
```

- `count: 0` = a área é sua e não há nada. `count: null` = a contagem falhou
  agora; a tela diz "indisponível". Cada sinal é contado isolado — uma consulta
  que cai não derruba as outras.
- Ordem: severidade (`CRITICAL`, `WARNING`, `INFO`) e depois a ordem do
  catálogo.

| Chave | Permissão | Severidade | O que conta |
|---|---|---|---|
| `operations.job_runs_stalled` | `operations:read` | CRITICAL | `JobRun` em `RUNNING` com lease vencido |
| `billing.invoices_overdue` | `billing:read` | CRITICAL | Fatura `PENDING` com vencimento passado |
| `support.tickets_high_priority_open` | `support:read` | CRITICAL | Chamado `HIGH`/`CRITICAL` em `OPEN`/`IN_PROGRESS` |
| `support.tickets_unassigned` | `support:read` | WARNING | Chamado `OPEN` sem responsável |
| `integrations.unhealthy` | `integrations:read` | WARNING | Credencial `TOKEN_EXPIRED`/`ERROR`, ou conectada com último sync falhado |
| `operations.job_runs_failed_recent` | `operations:read` | WARNING | `JobRun` `FAILED` nas últimas 24h |
| `subscriptions.past_due` | `subscriptions:read` | WARNING | Assinatura de organização `PAST_DUE`/`UNPAID` |
| `billing.invoices_failed_recent` | `billing:read` | WARNING | Fatura `FAILED` nos últimos 30 dias |
| `orgs.contracts_awaiting_activation` | `orgs:manage` | WARNING | Contrato `SIGNED` (só ativar resolve — só administração vê) |
| `billing.contracts_awaiting_first_payment` | `billing:read` | INFO | Contrato `PENDING_ACTIVATION` |
| `leads.awaiting_qualification` | `leads:read` | INFO | Lead `NEW` |
| `contacts.unread` | `contacts:read` | INFO | Fale-conosco `NEW` |
| `subscriptions.trials_ending_soon` | `subscriptions:read` | INFO | Trial que vence nos próximos 7 dias |

**Por que a resposta traz a permissão e não a área:** o agrupamento em áreas é
navegação, e é da web. O item de menu "Faturas" exige `billing:read`; o sinal
`billing.invoices_overdue` também. A web casa os dois e sabe em que card o
contador cai. Se a API devolvesse "Billing & Finance", mover um item de área
exigiria deploy do backend.

### 3.2 O que o `allva-backoffice-api` precisa devolver em `GET /api/v1/hub/attention`

**Exatamente o mesmo formato** do §3.1, com chaves próprias, para a web
concatenar as duas listas sem tratar caso a caso. Mesmas regras: filtrar por
`platformPermissions`, não devolver sinal fora da área, `null` quando a
contagem falhar, ordenar por severidade.

Sinais iniciais (derivados de C1, §4.1):

| Chave | Permissão | Severidade | O que conta |
|---|---|---|---|
| `support.sla_breached` | `support:read` | CRITICAL | Chamados abertos cujo prazo de SLA (primeira resposta ou resolução) já passou |
| `support.sla_at_risk` | `support:read` | WARNING | Chamados que estouram o SLA nas próximas 2h |
| `support.escalated` | `support:read` | WARNING | Chamados escalonados e ainda não assumidos por quem recebeu a escalação |
| `support.assigned_to_me_waiting` | `support:read` | INFO | Chamados atribuídos **ao operador que chama** cuja última mensagem é do cliente |
| `alerts.unacknowledged` | a do alerta (ex.: `operations:read`) | varia | Alertas internos (C4) disparados e não reconhecidos |

`support.assigned_to_me_waiting` é o único sinal pessoal (depende de quem
chama, não só da área). Ele precisa da última mensagem de cada chamado, que
está no `allva-api`: ou o backoffice-api consulta
`GET /api/v1/admin/support/tickets?assignee=<id>` e filtra, ou se pede ao
`allva-api` um filtro `awaiting=OPERATOR` nessa rota — preferível, porque o
`allva-api` já tem a tabela de mensagens.

Tratar chave nova como contrato: a web mapeia chave → texto ("3 chamados com
SLA estourado"). Chave desconhecida para a web é ignorada, não quebra a tela.

### 3.3 Onde o hub **não** deve ser composto

Não criar no backoffice-api um `GET /api/v1/hub` que chame o `allva-api` e devolva
tudo junto. A tentação é "uma chamada só para a web", mas o custo é que uma
lentidão no `allva-api` vira lentidão do backoffice-api inteiro, e os dois
passam a cair juntos. A web (via BFF do Next) faz as duas chamadas em
paralelo e mostra cada lado quando chega.

---

## 4. O que o `allva-backoffice-api` precisa implementar

Numeração herdada do mapa de endpoints do backoffice-web (balde C).

### 4.1 C1 — Processo de atendimento

**O que já está no `allva-api` e não deve ser replicado:** o chamado, as
mensagens, o status, a prioridade, a categoria e o **responsável atual**
(`support_tickets.operator_id`, alterado por
`PATCH /api/v1/admin/support/tickets/:id`, que já valida se o responsável tem
`support:manage`).

**O que é do backoffice-api:**

1. **Histórico de atribuição.** Tabela `ticket_assignment_events`:
   `id`, `ticket_id` (referência opaca ao `allva-api`), `from_operator_id`,
   `to_operator_id`, `actor_id`, `reason` (obrigatório em reatribuição, opcional
   na primeira atribuição), `created_at`. Gravado **pelo backoffice-api**
   quando ele mesmo intermedia a reatribuição:
   `POST /api/v1/support/tickets/:ticketId/assignment` (`support:manage`) →
   chama o `PATCH` do `allva-api` → se `200`, grava o evento. Se o `allva-api`
   recusar, nada é gravado. Se a gravação local falhar depois do `200`,
   registrar e reconciliar (a atribuição real é a do `allva-api`).
2. **Política de SLA.** Tabela `sla_policies`: por `priority` (e
   opcionalmente `category`), `first_response_minutes`,
   `resolution_minutes`, `business_hours` (boolean), `active`. CRUD em
   `/api/v1/support/sla-policies` — leitura `support:read`, escrita
   `settings:manage` (política é configuração, não atendimento).
3. **Cálculo de prazo.** Para cada chamado aberto:
   `due_first_response_at` e `due_resolution_at`, a partir de `created_at`,
   da prioridade e da política vigente **no momento da abertura** (mudar a
   política não reescreve prazo de chamado antigo). Precisa do calendário de
   horário comercial se `business_hours`.
4. **Escalonamento.** Regra por tempo em aberto: ao estourar o SLA, o chamado
   é marcado `escalated_at`, `escalated_to` (operador ou grupo) e gera alerta
   (C4). Job periódico (a cada 5 min) no backoffice-api.
5. **Fila de trabalho.** `GET /api/v1/support/queue` (`support:read`): a lista do
   `allva-api` enriquecida com prazo, estado de SLA (`ON_TRACK`, `AT_RISK`,
   `BREACHED`) e escalonamento, ordenada por risco. Paginação igual à do
   `allva-api` (`page`, `pageSize`, `{ items, total, page, pageSize }`).

**De onde vêm os eventos do chamado:** o `allva-api` não publica eventos para
fora hoje. Até publicar, o backoffice-api descobre mudança por **polling** de
`GET /api/v1/admin/support/tickets` ordenado por `lastMessageAt` (a cada
1–2 min, com marca d'água). Pedir webhook/fila ao `allva-api` quando o volume
justificar — é a mudança certa, mas não é pré-requisito.

### 4.2 C5 — Métricas de atendimento

Derivadas de C1, não do produto. `GET /api/v1/support/metrics?from=&to=&operatorId=`
(`support:read`; filtrar por outro operador exige `support:manage`):

- tempo até a primeira resposta (mediana e p90);
- tempo até a resolução;
- volume por operador (atribuídos, resolvidos, reabertos);
- % dentro do SLA.

"Primeira resposta" é a primeira mensagem de operador no chamado — dado do
`allva-api`. Guardar no backoffice-api `first_operator_reply_at` por chamado
ao observá-la no polling, para não recalcular a série inteira a cada consulta.

Não confundir com o "tempo médio de resolução" da tela do **cliente**: aquilo
é o cliente olhando os próprios chamados, e continua no `allva-api`.

### 4.3 C2 — Anotações internas sobre contas

Observações de operador sobre uma organização, uma conta ou um lead,
visíveis **só no backoffice**. Nunca trafegam para o produto — é isso que as
separa de um campo em `organizations`.

- Tabela `internal_notes`: `id`, `subject_type` (`ORGANIZATION` | `ACCOUNT` |
  `SALES_LEAD` | `CONTRACT`), `subject_id`, `author_id`, `body`,
  `pinned`, `created_at`, `edited_at`, `deleted_at`.
- `GET /api/v1/notes?subjectType=&subjectId=` e `POST /api/v1/notes`, `PATCH /api/v1/notes/:id`,
  `DELETE /api/v1/notes/:id` (soft delete; só o autor ou quem tem `settings:manage`).
- **Permissão segue o assunto:** ler nota de organização exige `orgs:read`;
  de lead, `leads:read`; de contrato, `billing:read`. Escrever exige a mesma
  permissão de leitura — anotar não altera o cliente. Isso impede que o
  comercial leia anotações financeiras só porque vê a organização: se uma nota
  precisar ser restrita, ela ganha `visibility` com a permissão mínima
  (`billing:read`, por ex.), e a leitura filtra por ela.
- Diferente das notas internas de um **chamado**, que são mensagens do
  chamado e moram no `allva-api`.

### 4.4 C3 — Preferências e visões salvas do operador

Estado de interface, sem valor para o produto.

- `operator_preferences` (1 por operador): `last_workspace` (o hub pode
  destacar a área usada por último — sem redirecionar: todo mundo passa pelo
  hub), `sidebar_collapsed`, `density`, `timezone`.
  `GET/PUT /api/v1/me/preferences`. Sem permissão além de ser operador.
- `saved_views`: `id`, `operator_id`, `screen` (`organizations`, `leads`,
  `support`…), `name`, `filters` (JSON), `columns`, `sort`, `is_default`,
  `shared` (visível para outros operadores com a permissão de leitura da
  tela). `GET/POST/PATCH/DELETE /api/v1/views?screen=`.
- Ao aplicar uma visão, a tela só usa filtros que a API de destino aceita;
  o backoffice-api não valida filtro de tela alheia, só guarda.
- Uma visão compartilhada de uma tela cuja permissão o operador perdeu some
  da lista dele — filtrar por `platformPermissions` na leitura.

### 4.5 C4 — Alertas operacionais internos

O `allva-api` produz o fato (o sinal do §3.1, o job que falhou); decidir
**quem acorda** é do backoffice-api.

- `alert_rules`: `source` (chave de sinal do §3.1 ou §3.2), `threshold`
  (ex.: `count >= 1`), `channel` (`EMAIL` | `SLACK`), `target` (endereço ou
  canal), `required_permission` (quem pode ver e reconhecer), `quiet_hours`,
  `active`. CRUD exige `settings:manage`.
- `alert_events`: disparo, `acknowledged_by`, `acknowledged_at`.
- Job que lê os dois `attention` a cada N minutos **com uma credencial de
  serviço** (§6) e dispara pelas regras. Deduplicar: mesmo alerta aberto não
  dispara de novo até ser reconhecido ou o sinal zerar.
- `POST /api/v1/alerts/:id/acknowledge` exige a `required_permission` da regra.

### 4.6 C6 — Minuta e termos pré-assinatura

O `EnterpriseContract` do `allva-api` nasce em `SIGNED`, por decisão de
domínio: antes disso o funil é o `SalesLeadStatus`. Entre "termos acordados" e
"PDF assinado voltou" os termos não têm casa — são estado do processo de venda.

- `contract_drafts`: `id`, `sales_lead_id`, os mesmos campos de termo que
  `POST /api/v1/admin/contracts` aceita (plano, valores, vigência, limites,
  forma e prazo de pagamento), `status` (`DRAFT` | `SENT_FOR_SIGNATURE` |
  `SIGNED` | `ABANDONED`), `draft_document_key` (a **minuta** enviada para
  assinatura, não o PDF assinado), `signature_provider`, `envelope_id`,
  `envelope_status`, `created_by`, timestamps.
- Leitura `billing:read`; escrita `billing:manage`.
- **Conversão:** ao chegar em `SIGNED`, o backoffice-api chama
  `POST /api/v1/admin/contracts` com os termos e guarda o `contractId`
  devolvido. Idempotência: guardar `contract_id` e não reenviar se já houver.
- É onde uma plataforma de assinatura digital pluga: o webhook dela escreve
  aqui, não no `allva-api`.

**O PDF assinado não é do backoffice-api.** Ele é a prova do que o cliente
contratou, e pela régua do início deste documento é dado do produto: mora no
`EnterpriseContract` (`signed_document_url`), no bucket privado do `allva-api`.

- Upload: `POST /api/v1/admin/contracts/:id/signed-document`, multipart com o
  campo `file`, só PDF (tipo e assinatura `%PDF-` conferidos), até 20 MB,
  `billing:manage`. Audita `contract.signed_document.attached` sem a URL.
- Leitura: a URL sai assinada em qualquer resposta do contrato
  (`SignedStorageUrlInterceptor`); o bucket não é público.
- Troca: antes da ativação, enviar de novo substitui o arquivo e apaga o
  anterior do bucket. Depois da ativação, só anexa se ainda não houver
  documento — senão `409 CONTRACT_DOCUMENT_LOCKED`. Mudança de acordo é
  aditivo, não troca de PDF.
- O link externo (`signedDocumentUrl` no create/patch) continua aceito para
  quem assina em plataforma de terceiros.
- Na conversão acima, quando o envelope voltar assinado, o backoffice-api
  cria o contrato e então **envia o PDF assinado para esta rota**; ele não
  guarda cópia própria. Até o backoffice-api existir, a
  `allva-backoffice-web` chama a rota direto pelo BFF, depois de criar o
  contrato no passo de assinatura.

### 4.7 Auditoria do próprio backoffice-api

Toda escrita do backoffice-api (reatribuição, nota, regra de alerta, SLA,
minuta) grava em `backoffice_audit_logs`: `actor_id`, `action`,
`subject_type`, `subject_id`, `before`, `after`, `reason`, `ip`,
`user_agent`, `created_at`. Nunca apagar.

`GET /api/v1/audit-logs` (`audit:read`) com os mesmos filtros que o `allva-api`
terá em B8 (ator, organização, faixa de tempo, ação), no mesmo formato de
item, para a área **Governance** mostrar as duas trilhas numa lista só (a web
intercala por `created_at`).

---

## 5. O que **não** é do `allva-backoffice-api`

Estes itens aparecem nas telas do backoffice mas são dados do produto. O
backoffice-api **não** deve criar tabela nem endpoint para eles — eles são
backlog do `allva-api` (mapa de endpoints do backoffice-web, balde B).

| Item | Estado no `allva-api` |
|---|---|
| B0 — `platformRole`/`platformPermissions` no `/auth/me` | Entregue |
| B3 — trocar papel de plataforma | Entregue (`PATCH /admin/accounts/:id/platform-role`) |
| B10 — fila de chamados | Entregue (`/admin/support/tickets`) |
| B11 — contatos restritos a operador | Entregue |
| B13 — papéis por capacidade | Entregue |
| Hub — sinais de atenção do produto | Entregue (`GET /admin/attention`, módulo `operations-hub`) |
| B1, B14 — organizações (lista e detalhe) | Entregue (`/admin/organizations`, módulo `platform-admin`) |
| B2 — contas | Entregue (`/admin/accounts/customers`, `/operators`, `/:id`) |
| B4 — assinaturas | Entregue (`/admin/subscriptions`) |
| B5 — integrações | Entregue (`/admin/integrations`) |
| B6 — ler `JobRun` | Entregue (`/admin/job-runs`) |
| B8 — trilha unificada | Entregue (`/admin/audit-logs`) |
| B9 — overview do dashboard | Entregue (`/admin/overview`, filtrado por permissão) |
| B12 — faturas | Entregue (`GET /admin/invoices`) |
| B21 — filtro de período em contatos | Entregue |
| B7 — reprocessar `JobRun` | A fazer |
| B15, B16, B17, B18, B19, B20 | A fazer |

Se o backoffice-api precisar de um desses para uma funcionalidade dele, a
dependência é **consumir** o endpoint quando existir — nunca ler o banco do
`allva-api` diretamente.

---

## 6. Requisitos não funcionais

- **Banco próprio.** Nenhuma conexão ao Postgres do `allva-api`. Referências
  ao produto são ids opacos (`organization_id`, `ticket_id`, `sales_lead_id`)
  sem FK.
- **Referência órfã.** Organização excluída no `allva-api` responde `404`
  (ou some das listagens). O backoffice-api trata na leitura — nota de
  organização inexistente continua existindo, e a tela mostra "organização
  removida". Não apagar em cascata por inferência.
- **Credencial de serviço.** Jobs (polling de chamados, alertas) não têm
  operador logado. Precisam de uma conta de serviço no `allva-api` com papel
  de plataforma próprio e só as permissões de leitura necessárias — **não**
  reutilizar o token de um operador humano nem uma conta `ALLVA_ADMIN`.
  Hoje não existe papel de serviço: pedir ao `allva-api` (ex.:
  `ALLVA_SERVICE` com `support:read`, `operations:read`, `billing:read`,
  `integrations:read`, `subscriptions:read`), pelo caminho do §1.4.3.
- **Isolamento de falha.** Cada chamada ao `allva-api` com timeout e sem
  retry síncrono em cadeia. O hub e as telas mostram o que chegou.
- **Paginação** no formato do `allva-api`: `page`, `pageSize` (padrão 20),
  `{ items, total, page, pageSize }`.
- **Erros** no formato do `allva-api`: `{ code, message, details? }`, códigos
  em `SCREAMING_SNAKE_CASE`.
- **Rate limit** por operador nas rotas de escrita.

---

## 7. Contrato com o `allva-backoffice-web`

O backoffice-api não implementa nada disto, mas as duas peças precisam
concordar. Registrado aqui para que a web não peça ao backoffice-api o que é
dela.

1. **Registro canônico de navegação** na web: cada item declara `href`,
   `label`, `permission` e `workspace`. Hub, sidebar, breadcrumbs, command
   palette e ações rápidas derivam dele — nenhum tem regra própria.
2. **Áreas**, adaptadas à matriz atual:

   | Área | Itens (permissão de cada) |
   |---|---|
   | Customer Operations | Organizations (`orgs:read`), Users (`users:read`), Leads (`leads:read`) |
   | Support | Tickets (`support:read`), Contacts (`contacts:read`) |
   | Billing & Finance | Subscriptions (`subscriptions:read`), Payments (`billing:read`) |
   | Platform Operations | Integrations (`integrations:read`), Operations (`operations:read`) |
   | Governance | Audit (`audit:read`) |
   | Administration | Operators (`users:read`; escrever pede `users:manage_platform_role`), Settings (`settings:read`) |

   Dashboard (`dashboard:read`) fica fora das áreas, como módulo próprio.
3. **Consulta vs. área de trabalho.** Todo papel tem `orgs:read` (suporte e
   financeiro precisam consultar a organização que atendem). Se a regra do
   card fosse "algum item visível", **todo** operador veria Customer
   Operations, e o hub deixaria de focar. Recomendação: o item declara
   `lookup: true` quando a permissão é de consulta de apoio (`orgs:read`,
   `users:read`, e `integrations:read` e `subscriptions:read` para o suporte). O card aparece se o operador
   tem ao menos um item **não-lookup** da área; o item de consulta continua
   acessível na sidebar e pela busca. Com isso:

   | Papel | Cards no hub |
   |---|---|
   | `ALLVA_ADMIN` | todos os seis |
   | `ALLVA_OPERATOR` | Platform Operations, Governance |
   | `ALLVA_SUPPORT` | Support (Integrations e Subscriptions ficam como consulta na sidebar, sem card) |
   | `ALLVA_FINANCE` | Billing & Finance |
   | `ALLVA_SALES` | Customer Operations (via Leads) |

   Qual permissão é "lookup" em qual área é decisão de produto — aberta (§8).
4. **Guarda de tela** (o par do `EntitlementGuard` do `allva-frontend`): toda
   rota do backoffice-web passa por `guardScreen(url)` no início da página
   (`modules/<área>/<área>-page.tsx`),
   antes de buscar dado, com a permissão do item. `/home` exige apenas
   `platformRole !== null`, cobrado pelo portão do layout. *(Implementado.)*
5. **Sinais.** A web chama `GET /api/v1/admin/attention` (allva-api) e
   `GET /api/v1/hub/attention` (backoffice-api) em paralelo, casa
   `signal.permission` com o item de navegação para achar o card, soma os
   contadores por card, e lista os sinais com `count > 0` em "Requires
   attention". `count: null` vira "indisponível" no card, nunca zero.
6. **403 da API** é recusa declarada: mostrar `details.permission` e o papel
   do operador, como o `ScreenGuard` já faz.
7. O backoffice-web não tem mais mock: lê identidade e permissões do
   `/auth/me` e todos os dados das rotas acima. Os seis itens deste contrato
   estão implementados (`src/modules/platform/navigation.ts`, `signals.ts`,
   `components/screen-guard.tsx`, `app/(backoffice)/home`).

---

## 8. Decisões em aberto

1. **Granularidade dos papéis.** `workspace-screen.md` imagina
   `SUPPORT_AGENT`/`SUPPORT_MANAGER`, `FINANCE_ANALYST`/`FINANCE_MANAGER` etc.
   Hoje há um papel por área. O primeiro gatilho real para dividir é C1:
   reatribuir chamado de outro operador e editar SLA soam como "gerente".
   Quando acontecer, é enum + linha de matriz no `allva-api`
   (`ALTER TYPE … ADD VALUE`), e o teste de paridade impede papel sem linha.
   Nada no backoffice-api muda, porque ele decide por permissão.
2. **Uma conta, mais de um papel?** Exige tabela de associação no
   `allva-api`. `platformPermissions` passaria a ser a união — o contrato do
   `/auth/me` não muda, `platformRole` sim (vira lista).
3. **Quais permissões são "lookup" por área** (§7.3).
4. **Papel de serviço** para os jobs do backoffice-api (§6).
5. **Eventos do `allva-api` para fora** (webhook ou fila) para substituir o
   polling de C1.
