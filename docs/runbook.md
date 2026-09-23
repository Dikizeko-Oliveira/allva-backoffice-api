# Runbook operacional

> Sprint 6 / Ops readiness. Escopo: subir, diagnosticar e derrubar com segurança.
> A classificação de variáveis de ambiente está em [`env-secrets.md`](env-secrets.md).

## Dependências de infraestrutura

| Dependência | Classe | Sem ela |
|---|---|---|
| **PostgreSQL** (`DATABASE_URL`) | Crítica | Boot falha na validação do schema; `/health` devolve **503** |
| **Redis** (`REDIS_URL`) | Crítica | Nenhuma fila processa; `/health` devolve **503**. Ver abaixo |
| S3 (`AWS_*`) | Opcional | Upload de criativo e preview falham no request; app sobe |
| Provider de IA (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) | Opcional | Análise de campanha falha no request; app sobe |
| ffmpeg (`FFMPEG_PATH` / `ffmpeg-static`) | Opcional | Preview de vídeo não é gerado; `optional.videoPreview=unavailable` |

### Dependência de Redis — o que exatamente depende

Redis é **crítico**, e não só para "filas em geral". Seis fluxos morrem sem ele:

| Fila / cron | Agendamento | O que para |
|---|---|---|
| `allva-campaign-analysis` | sob demanda | Análise de campanha nunca sai de `PENDING` |
| `allva-video-processing` | sob demanda | Preview de primeiro frame (`preview_status` fica `PENDING`) |
| `allva-ads-sync-daily` | `ADS_SYNC_CRON` (padrão `0 3 * * *`) | Métricas de ads param de entrar |
| `allva-ads-token-refresh` | `0 */12 * * *` | Tokens de integração expiram sem renovar |
| `allva-waste-detection-daily` | `0 4 * * *` | Detecção de desperdício |
| `allva-recommendations-generation-daily` | `30 4 * * *` | Geração de recomendações |
| `daily-summary` | `0 8 * * *` (America/Sao_Paulo) | E-mail de resumo diário |

**O que NÃO depende de Redis** — e importa saber, porque é contraintuitivo:

- **Rate limiting global** (`ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])`) usa o
  storage **in-memory** padrão, sem adapter de Redis. Ou seja: o limite é **por instância**.
  Com N instâncias atrás do load balancer, o teto efetivo é `N × 120/min`. É aceitável como
  guarda grosseira de DoS, mas **não** trate como limite global.
- **Proteção de brute force** (`BruteForceProtectionService`) conta em cima de
  `security_audit_logs` no **Postgres**, então é corretamente compartilhada entre instâncias.
  Essa é a proteção que de fato importa para login/reset de senha.

> Consequência prática: escalar horizontalmente dilui o throttler global, mas **não** a
> proteção de brute force. Se o throttler global precisar ser real, o caminho é um
> `ThrottlerStorageRedisService` — não está feito.

O `ProviderHealthRegistry` (cooldown de provider de IA) também é por processo, por decisão
registrada no PLAN.md: cooldown é otimização de latência, não correção.

## Falhas de boot: como diagnosticar

O processo se recusa a subir em três situações, todas com mensagem nomeando a variável.

### 1. Variável crítica ausente

```
ZodError: ... "path": ["DATABASE_URL"] ...
```

Críticas: `DATABASE_URL`, `JWT_SECRET_KEY`, `REDIS_URL`, `INTEGRATION_TOKEN_ENCRYPTION_KEY`,
`FRONTEND_URL`. `JWT_SECRET_KEY` e `INTEGRATION_TOKEN_ENCRYPTION_KEY` exigem ≥ 32 caracteres.

### 2. Segredo de webhook ausente **em produção**

```
"path": ["STRIPE_WEBHOOK_SECRET"]
"message": "STRIPE_WEBHOOK_SECRET is required in production when STRIPE_SECRET_KEY
            is set: without it every Stripe webhook fails signature verification
            and billing stops reconciling."
```

Isto é intencional e **não deve ser contornado**. Sem o segredo, o endpoint de webhook não
consegue verificar assinatura, e evento de billing forjado concede acesso pago. Falhar o
deploy é estritamente melhor que servir esse endpoint.

Saídas legítimas:
- configurar o segredo (correto);
- ou remover `STRIPE_SECRET_KEY`, desativando o billing — a regra só exige o segredo
  quando o provedor está configurado.

### 3. Erro de formato

`DATABASE_URL` precisa ser URL válida; `EMAIL_FROM`, e-mail válido; `EMAIL_PROVIDER` ∈
`console | smtp | brevo`.

## Boot bem-sucedido: o que conferir no log

```
config.readiness_ok                          # nenhuma feature opcional degradada
config.degraded_features count=N env=production
config.degraded feature="S3 storage" missing=AWS_S3_BUCKET — ...
video_preview.ffmpeg_ready path=/app/node_modules/ffmpeg-static/ffmpeg
```

Em produção, cada `config.degraded` sai em nível **error** — quase sempre é erro de deploy.
Fora de produção sai em `log`, porque integração não configurada é o estado normal de uma
máquina de desenvolvimento.

## `GET /api/v1/health`

```json
{
  "status": "ok",
  "services": { "database": "ok", "redis": "ok" },
  "optional": { "videoPreview": "ok" }
}
```

- **Só `services` decide o status HTTP.** `database` ou `redis` fora → `status: degraded` + **503**.
- **`optional` nunca altera o status.** Preview é acessório; marcar a instância como degradada
  por causa dele a tiraria do load balancer e transformaria falha de feature em queda de site.
- Configure a sonda do load balancer para `/api/v1/health` e deixe que ela reaja ao código HTTP.

## Migrações

```cmd
pg_dump "$DATABASE_URL" > backup-$(date +%Y%m%d%H%M).sql   # sempre, antes de deploy
pnpm prisma migrate deploy
pnpm prisma migrate status
pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

O último comando é o único que detecta drift real: `migrate status` compara a **tabela** de
migrações, não o schema vivo. Exit `0` = sem diferença.

> `--from-schema-datasource` foi removido no Prisma 7. Use `--from-config-datasource`.

### Baseline consolidado (2026-07-26) — não há mais DDL destrutivo no histórico

O histórico tem **uma** migração: `20260726000000_baseline`, com **zero `DROP`**.

Até aqui eram 32 migrações, três delas destrutivas — dropavam 5 tabelas órfãs do pipeline
legado de campanha, `creative_assets.processing_status`, `accounts.mercado_pago_customer_id`
e reconstruíam os enums `CampaignStatus` e `BillingProvider`. Elas existiam só para desfazer
o que migrações anteriores criavam. Como o projeto nunca chegou a rodar em produção, não
havia histórico a preservar: o squash faz um ambiente novo nascer já sem o legado, então
não há nada a remover.

> **Não apague migrações de um histórico incremental achando que "sobram".** Foi medido:
> retirar as três de um banco novo e rodar `migrate deploy` deixava o schema divergente —
> as 5 tabelas órfãs, as duas colunas e as variantes de enum voltavam todas. Elas eram
> load-bearing. O que resolveu foi o squash, não a remoção.

O único banco vivo era o de desenvolvimento, reconciliado sem perda de dados:
`DROP` da tabela órfã restante → `DELETE FROM _prisma_migrations` →
`prisma migrate resolve --applied 20260726000000_baseline`. Verificado depois com
`migrate status` (up to date) e `migrate diff --exit-code` (sem diferença).

Provisionar um ambiente novo é agora só `prisma migrate deploy` — verificado num banco
limpo, que resulta em `migrate diff` sem diferença contra o `schema.prisma`.

## Kill switches (sem deploy)

| Variável | Efeito |
|---|---|
| `VIDEO_PREVIEW_ENABLED=false` | Para de enfileirar preview; jobs na fila viram no-op e o asset vai para `NOT_REQUIRED` |
| `SECURITY_BRUTE_FORCE_ENABLED=false` | Desliga o lockout progressivo. **Só para incidente**, e por pouco tempo |
| `ORG_SCOPED_ENTITLEMENT=false` | Volta o entitlement para assinatura pessoal apenas. Rollback do Sprint 2 |

## Diagnóstico rápido

| Sintoma | Onde olhar |
|---|---|
| Análise travada em `PENDING` | Redis no ar? `/health` → `services.redis`. Fila `allva-campaign-analysis` |
| Preview nunca aparece | `creative_assets.preview_status`: `NOT_REQUIRED` (flag off / não é vídeo), `PENDING` (fila), `FAILED` (ver `processing_error`) |
| Webhook de billing rejeitado com 400 | Segredo configurado? Log `Stripe webhook rejected` |
| Assinatura não ativa após pagamento | Webhook chegou? `billing_webhook_events`. Reconciliação faz backfill de Invoice/Payment |
| E-mail não sai | `config.degraded feature="Email delivery..."` no boot; `EMAIL_PROVIDER` e credenciais |
| Métricas de ads paradas | Cron `allva-ads-sync-daily`; token expirado → `allva-ads-token-refresh` |

---

# Operação ads-first (A2-S9)

Esta parte cobre o que o produto v2.0 acrescentou ao runbook: reconstrução,
rebind, kill switch de escrita, moeda em recomputo, quarentena, partições e
retenção. É a entrega 8 de A2-S9.

## Os jobs, e o que cada um quebra quando falha

A ordem é dado, não convenção: cada job resolve a dependência consultando
`JobRun`, nunca o horário (§16.14). A tabela vive em
[job-schedule.ts](../src/modules/sync/domain/job-schedule.ts).

| Job | Escopo · cadência | Se falhar |
|---|---|---|
| `ads-ingest` / `ads-ingest-full` | conta · hora / dia | a série para; tudo a jusante fica `staleObservation` |
| `ad-account-discovery` | integração · dia | contas novas não aparecem |
| `ads-reconcile` | conta · hora | drift com a plataforma deixa de ser detectado |
| `metrics-partition-maintenance` | global · mês (tick diário) | **o ingest falha inteiro** na virada do mês |
| `ad-scoring` | conta · dia | score congela; waste reporta `MISSING_SCORE` |
| `waste-detection` | conta · dia | o desperdício da tela envelhece |
| `denormalization-reconcile` | conta · dia | os totais de `ads` divergem da view em silêncio |
| `recommendations-generation` | org · dia | nada novo é proposto |
| `recommendation-lifecycle` | org · hora | vencidas continuam aplicáveis; diferidas não voltam |
| `recommendation-outcome-measure` | org · dia | **P8 para de acumular**: aplicadas ficam `PENDING_MEASUREMENT` |
| `action-execution-reaper` | global · 5 min | um alvo travado fica irrescrevível e a reco fica `APPLYING` |
| `data-retention` | global · mês (tick diário) | o banco cresce; nada quebra hoje |

**Nenhum deles é o gatilho principal.** A cadeia dirigida por evento é o caminho
normal; o cron é rede de segurança. Um `SKIPPED` com `UPSTREAM_NOT_READY` é
comportamento correto, não incidente.

### Como saber se um job rodou

```sql
SELECT job_name, scope_id, window_key, status, skip_reason,
       started_at, finished_at, attempt
  FROM job_runs
 WHERE job_name = 'recommendation-outcome-measure'
 ORDER BY started_at DESC LIMIT 20;
```

`RUNNING` com `lease_expires_at` no passado é worker morto: o takeover
condicional o recolhe na próxima execução. **Não apague a linha** — o histórico
de `attempt` é o que distingue "falhou uma vez" de "falha sempre".

## Kill switch de escrita (R1, RP5)

A ordem de contenção, do menos ao mais drástico:

| Passo | Como | Efeito |
|---|---|---|
| 1 | `PLATFORM_ACTIONS_DRY_RUN_ONLY=true` | toda escrita vira validação; `dryRun: false` é **recusado** antes de qualquer guarda |
| 2 | `POST /organizations/{id}/actions/kill-switch` | desliga uma organização, sem deploy, e entra na trilha de auditoria |
| 3 | `PLATFORM_ACTIONS_ENABLED=false` | desliga a instalação |

**O kill switch é reconferido no worker**, não só no `POST`: uma execução já
enfileirada quando a chave desce é cancelada em vez de escrita. É o que faz
"pare tudo agora" significar agora, e não "pare o que ainda não foi enfileirado".

Depois de acionar, o que ficou na fila aparece como `CANCELLED` com
`errorCode = 'ORGANIZATION_ACTIONS_DISABLED'`.

## Execução travada, e recomendação presa em `APPLYING`

Sintoma: `POST /ads/{id}/actions` responde `409 WRITE_IN_FLIGHT` apontando para
uma execução que ninguém processa.

1. `expiresAt` é `appliedAt + 15 min`. O reaper roda a cada 5 min: **espere 20
   minutos** antes de qualquer intervenção manual.
2. Se persistir, a fila está parada — verifique Redis e o worker de
   `allva-platform-actions`.
3. Uma recomendação em `APPLYING` sai sozinha quando a execução assenta **ou**
   quando o reaper a recolhe. As duas rotas chamam a mesma liquidação.

```sql
-- Execuções em voo há mais de 15 minutos
SELECT e.id, e.status, e.expires_at, a.type, a.ad_id, a.recommendation_id
  FROM action_executions e JOIN ad_actions a ON a.id = e.action_id
 WHERE e.status IN ('QUEUED','RUNNING') AND e.expires_at < now();
```

## Moeda em recomputo

Enquanto `OrgCurrencyState = RECOMPUTING_CURRENCY`, os jobs de inteligência
registram `SKIPPED` com `CURRENCY_RECOMPUTING` e as rotas devolvem `503` tipado.
**Isso é correto**: números em moeda-base antiga misturados com nova não são
comparáveis, e exibi-los seria pior que a indisponibilidade.

Acompanhe por `currency_migrations`; a retomada é idempotente.

## Quarentena de sync

Ad que chegou antes da campanha dele vai para `sync_quarantine` em vez de
entrar pela metade. `GET /sync/quarantine` lista; o ciclo seguinte reprocessa
sozinho quando a dependência aparece. Item que não sai depois de dois ciclos
indica ingestão parcial recorrente — olhe `sync_operations.was_complete`.

## Partições e retenção

**As duas rodam no mesmo tick diário, em horários separados e nessa ordem:**
02h05 cria as futuras, 03h05 poda as vencidas. A ordem importa — invertida, uma
falha da poda que segurasse a janela adiaria a criação, e é a criação que quebra
o ingest inteiro na virada do mês.

```sql
-- Margem de partições. G4 exige ≥ 3 meses à frente.
SELECT c.relname FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = 'ad_metric_snapshots' ORDER BY c.relname DESC LIMIT 6;

-- A DEFAULT tem de estar vazia. Linha aqui = houve ingest sem partição.
SELECT count(*) FROM ad_metric_snapshots_default;
```

**A retenção não tem desfazer.** `DROP PARTITION` remove os arquivos. A política
está em [retention-policy.ts](../src/modules/sync/domain/retention-policy.ts) e a
fronteira é testada sem banco: só partições **inteiramente** anteriores ao corte
de 13 meses saem. `action_executions`, `ad_actions`, `recommendation_outcomes` e
as trilhas de auditoria são **isentos** — trilha de escrita em mídia paga (P5) e
dataset de acurácia de §20-H3 não têm prazo de validade.

Toda poda entra no log em `warn` (`retention.applied`). Uma poda silenciosa é
indistinguível de perda de dado quando alguém for procurar meses depois.

## Medição de impacto parada (P8)

Sintoma: aplicadas acumulando em `PENDING_MEASUREMENT`.

```sql
SELECT status, count(*), min(applied_at)
  FROM recommendation_outcomes GROUP BY status;
```

O job **espera duas janelas**: a pós (`windowDays`) e a de re-declaração da conta
(`restatementWindowDays`, §8.9). Uma linha aplicada há 10 dias numa conta de 14
dias de atribuição ainda não é medível — e isso é o desenho, não atraso. Medir
antes produziria um número que muda sozinho depois.

`ABANDONED` significa janela sem nenhum dia observado, duas janelas depois do
prazo. Não é falha do job: é o desfecho honesto de um anúncio que parou de ser
observável.

## Rebind de integração (P10)

Reconectar uma conta **preserva** `ads.id`, `lineage_id` e todas as contagens. O
casamento é por `(organizationId, platform, externalAccountId)`, nunca pela
credencial. Se um rebind criou entidades duplicadas, o `externalAccountId` mudou
do lado da plataforma — investigue antes de mexer, porque a correção é manual e a
identidade é o que P10 promete.

## Reconstrução de schema

**A janela de D9.1 está fechada.** A partir do primeiro onboarding real existe
histórico que o produto promete não perder; qualquer mudança destrutiva volta a
exigir Expand→Migrate→Contract. `20260801000000_ads_first_v2` foi a última
migração destrutiva, e a premissa que a autorizou não é mais invocável.
