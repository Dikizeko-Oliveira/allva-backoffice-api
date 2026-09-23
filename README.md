<div align="center">

# ✨ Allva API

**Ads Intelligence Platform: encontra o desperdício em anúncios que já estão no ar, explica por quê, recomenda a correção, aplica na plataforma e mede o que aconteceu depois.**

Arquitetura limpa • Determinístico primeiro, IA por cima • Multi-plataforma por contrato

</div>

---

## Visão Geral

A **Allva API** é o backend de uma **Ads Intelligence Platform**. Ela não origina mídia, não
substitui o Ads Manager e não disputa a superfície de criação — **convive** com ela. Existe para
responder cinco perguntas sobre anúncios **que já estão veiculando**:

| # | Pergunta do usuário | Capacidade | Estágio do ciclo |
|---|---|---|---|
| 1 | Onde estou perdendo dinheiro agora? | Waste Detector | `DETECT` |
| 2 | Por que este anúncio está mal? | AI Score + Creative Lab | `SCORE` |
| 3 | O que eu faço a respeito? | Recommendation Engine | `RECOMMEND` |
| 4 | Faça por mim — e confirme que foi feito | Platform Actions + Sync | `APPLY` / `VERIFY` |
| 5 | Funcionou? | Medição pré/pós | `LEARN` |

**Teste de escopo (estrela-guia).** Nenhuma capacidade entra no produto sem responder a uma dessas
cinco perguntas. A pergunta de review é sempre: *isso ajuda a encontrar desperdício e otimizar
anúncios?* Se não, não entra — independentemente de ser boa prática.

Fora de escopo **permanentemente**, por decisão de posicionamento e não por backlog: criação de
campanhas, conjuntos ou anúncios; editor de criativo; gestão de públicos, pixels ou catálogos.
Campanha e conjunto existem no domínio só como **contexto estrutural de leitura**
(`GET /api/v1/campaigns`, `/ad-sets`), necessário à interoperabilidade com Meta, Google e TikTok.

O contrato completo está em
**[docs/allva-ads-intelligence-architecture-v2-revisada.md](docs/allva-ads-intelligence-architecture-v2-revisada.md)**.

### Princípios que o review aplica

- **P1 — não origina mídia; no máximo deriva.** Nenhuma entidade de mídia nasce de um formulário da
  Allva: toda linha veio de um sync ou de uma ação tipada sobre um anúncio que já existe.
- **P2 — o anúncio é a unidade de verdade.** Toda inteligência persistida tem `ad_id`.
- **P4 — determinístico primeiro, IA por cima.** O núcleo dos scores é reprodutível; a IA enriquece
  o texto, nunca decide o número. Um valor que muda entre execuções por temperatura de LLM não pode
  ancorar a decisão de pausar mídia paga.
- **Silêncio é resposta válida.** Cada detector declara seu `minimumEvidence` e devolve `null`
  abaixo dele. Falso positivo aqui custa dinheiro do cliente: mandar pausar um anúncio ainda em
  aprendizado destrói tanto valor quanto o desperdício que se queria evitar. Precisão vale mais que
  cobertura.
- **Procedência numérica.** O contrato rotula `observedDelta`, jamais `causedSavings`, e expõe os
  `confounders` detectáveis. Medição pré/pós não é atribuição causal, e o número vem acompanhado do
  que se sabe contra ele.

---

## Stack Principal

- **Node.js + NestJS**
- **TypeScript**
- **PostgreSQL**
- **Prisma ORM**
- **Bull / Filas**
- **OpenAI + Anthropic (providers intercambiáveis, com fallback e cooldown)**
- **Stripe (pagamentos)**
- **Google Cloud Storage** — padrão; S3 disponível via `STORAGE_PROVIDER=S3`

---

## O ciclo de valor

O produto é um loop diário por anúncio. Cada estágio é um módulo, cada seta é uma fronteira, e a
ordem do diagrama é a ordem de dependência real — quatro detectores consomem componentes do
`AdScore`, então `SCORE` precede `DETECT`.

```
INGEST → SCORE → DETECT → RECOMMEND → APPLY → VERIFY → LEARN
```

| Quando | Job | Estágio |
|---|---|---|
| `:10` de hora em hora | `ads-ingest` — incremental | `INGEST` |
| `03:20` | `ads-ingest-full` — varredura completa; **a única que arquiva**, porque `updated_since` não reporta remoção | `INGEST` |
| `05:00` | `analysis-scope` | — |
| `05:30` | `ad-scoring` | `SCORE` |
| `06:00` | `waste-detection` | `DETECT` |
| `07:00` | `recommendations-generation` | `RECOMMEND` |
| `:15` de hora em hora | `recommendation-lifecycle` | `RECOMMEND` |
| `08:00` | `recommendation-outcome-measure` | `LEARN` |
| a cada 5 min | `action-execution-reaper` | `VERIFY` |

---

## O que a API faz?

**Núcleo do produto**

- Sincronização multi-plataforma (Meta, Google, TikTok) em quatro granularidades — campanha,
  conjunto, anúncio e criativo — com credencial cifrada em AES-256-GCM
- Leitura do anúncio como agregado, com pisos de confiança e linhagem:
  `GET /api/v1/ads`, `/:id/analysis`, `/:id/metrics`, `/:id/history`, `/:id/scores`
- Detecção de desperdício e de oportunidade, cada detector com seu piso de evidência:
  `/api/v1/waste/summary`, `/items`, `/opportunities`, `/by-ad`, `/rollup`
- Recomendações executáveis e seu ciclo de vida: `/api/v1/recommendations`
- Ações na plataforma com consentimento de escrita explícito, execução rastreável, reversão e lote:
  `POST /api/v1/ads/:id/actions`, `/actions/executions/:id/revert`, `/actions/batch`
- Medição pré/pós do que foi aplicado, versionada (`MEASUREMENT_VERSION`) e com confounders
- Copy Studio: geração de copy a partir de criativos **já veiculados** na conta, com cota por plano
  (`/api/v1/ads/:id/copy/generations`, `/api/v1/copy`)
- Analytics: visão geral, saúde por plataforma, alocação e pacing de orçamento, digest diário e
  insight cross-channel determinístico (`/api/v1/analytics`)

**Plataforma**

- Contas e sessões (JWT + refresh token com detecção de replay), recuperação de senha
- Multi-organização com RBAC, convites por token e trilha de auditoria
- Planos, assinaturas, consumo medido e paywall
- Upload de assets, com preview do primeiro frame de vídeo via ffmpeg
- Leads de vendas, contatos e provisionamento enterprise

Tudo isso com **logs de decisões de IA** e procedência versionada (`algoVersion`,
`detectorVersion`, `MEASUREMENT_VERSION`) para auditoria e transparência.

> **Análise pré-veiculação não existe e não voltará.** `POST /api/v1/creatives/upload` responde
> `FEATURE_REBUILDING` com `returnsIn: "nenhum sprint"` — a análise do anúncio veiculado a
> substitui. A rota permanece parqueada em vez de sumir para que o cliente distinga "isto volta" de
> "isto nunca existiu".

---

## Documentação da API

A API possui **documentação interativa completa**, disponível em dois formatos:

- **Swagger** — `/docs`
- **Scalar** — `/scalar`

---

## Arquitetura

O projeto segue **Clean Architecture**, separando claramente:

- **Core**: regras de negócio (use cases, entidades, portas)
- **Infra**: implementações técnicas (HTTP, Prisma, filas, providers)
- **Providers intercambiáveis**: IA, e-mail, storage, pagamentos
- **Repositórios por contrato**: a porta é uma classe abstrata; a implementação
  Prisma é injetada no módulo

Essa abordagem garante:

- Testabilidade
- Baixo acoplamento
- Facilidade de evolução
- Troca simples de infraestrutura

---

## Configuração e segredos

As variáveis são validadas no boot por um schema Zod (`shared/infrastructure/config/env.ts`).
Campo obrigatório ali significa **o processo não sobe sem ele**.

A regra que decide o que merece derrubar o boot e o que deve apenas degradar com log
está em **[docs/env-secrets.md](docs/env-secrets.md)** — junto com as divergências
conhecidas entre a regra e o schema atual. Vale ler antes de tornar qualquer variável
obrigatória: uma chave opcional exigida no construtor é como o boot quebrava antes do
Sprint 5.

---

## Entrega de alertas

Um alerta sempre aparece no painel. Virar **e-mail** exige passar por duas barreiras
independentes:

1. **Severidade** (`decideAlertDelivery`): só `WARNING` e `CRITICAL` são enviados.
   `INFO` fica no painel — se INFO gerasse e-mail, o usuário filtraria o remetente
   inteiro e perderia os críticos.
2. **Preferência** (`EmailPreferenceGate`, categoria `ALERT`): o flag
   `alertNotifications` (padrão ligado), com `notificationByEmail` como master switch
   acima dele. Sem linha de preferência, o e-mail é retido.

**Deduplicação.** `waste-detection` roda diariamente e re-reporta condições persistentes.
Cada alerta carrega um `fingerprint`; uma recorrência incrementa `occurrences` no alerta
**aberto** em vez de criar linha nova, e não dispara novo e-mail. Uma condição de uma
semana gera 1 e-mail, não 7.

**Ciclo de vida** (`PATCH /api/v1/alerts/:id/...`):

| Ação | Significado |
|---|---|
| `read` | Visto |
| `dismiss` | Tirar da fila, **sem** afirmar que o problema acabou |
| `resolve` | A condição acabou. Reabre a janela de dedupe: se o problema voltar, é alerta novo com e-mail novo |

`GET /api/v1/alerts` ordena por severidade e depois por data, e por padrão devolve só
alertas abertos (`?state=OPEN|DISMISSED|RESOLVED|ALL`).

> **Push não está implementado.** Não há modelo de device token nem provider configurado;
> a costura em `AlertNotifierService` permite um segundo canal quando isso for decidido.

---

## Testes e cobertura

```cmd
pnpm test          # suíte unitária
pnpm test:cov      # com o gate de cobertura
pnpm typecheck     # tsc --noEmit
```

O gate vive no `coverageThreshold` do `jest.config.js`, e não no CI, para que o
`pnpm test:cov` local reprove pelos mesmos limites. São dois níveis:

- **Piso global anti-regressão**, logo abaixo do baseline medido. Não bloqueia nada
  hoje; impede a cobertura cair. Sobe a cada sprint.
- **Limites altos por caminho crítico** (`ai/infrastructure/routing`,
  `shared/infrastructure/security`, `subscriptions/access/domain`) — dinheiro,
  permissão e roteamento. Regressão neles reprova o PR.

O Jest **subtrai** cada grupo com limite próprio do cálculo global, então o piso
`global` mede só os arquivos restantes — número naturalmente menor que o do repo
inteiro. O resumo publicado pelo CI mostra os dois lado a lado.

---

## Executando o projeto

```cmd
docker-compose up
```

### Preview de vídeo (ffmpeg)

O preview do criativo extrai o **primeiro frame** do vídeo em JPEG e envia para o
S3, gravando a URL em `creative_assets.first_frame_url`. O binário vem do pacote
`ffmpeg-static`, então **não** é preciso instalar ffmpeg no host.

- `VIDEO_PREVIEW_ENABLED` (padrão `true`): em `false`, nenhum job é enfileirado e
  os já enfileirados viram no-op — o `firstFrameUrl` simplesmente fica nulo. Use
  como kill switch, sem necessidade de deploy.
- `FFMPEG_PATH` (opcional): caminho para um ffmpeg do sistema, quando o binário
  empacotado não roda na imagem (ex.: base musl/Alpine).

Só fontes `http`/`https` são aceitas, e a whitelist de protocolos do ffmpeg exclui
`file` — um manifesto HLS malicioso não consegue ler o disco local.

#### Readiness do binário

O binário do `ffmpeg-static` é baixado por um **install script**. Um build com
`--ignore-scripts`, ou uma poda de `node_modules`, remove o binário sem que nada
mais mude — e antes disso ser observável a falha só aparecia quando um job da
fila quebrava. Hoje existem dois sinais:

1. **No boot** (`FfmpegBinaryLocator`): com `VIDEO_PREVIEW_ENABLED=true` e nenhum
   binário executável, sai um `ERROR video_preview.ffmpeg_unavailable` dizendo o
   que fazer. Com tudo certo, sai `video_preview.ffmpeg_ready path=...`.
2. **Em `GET /api/v1/health`**, no campo `optional.videoPreview`:

   ```json
   {
     "status": "ok",
     "services": { "database": "ok", "redis": "ok" },
     "optional": { "videoPreview": "unavailable" }
   }
   ```

   Valores: `ok`, `disabled` (flag off) e `unavailable` (flag on, sem binário).

O preview é **acessório**: `optional` nunca altera o `status` nem devolve 503.
Marcar a instância como degradada por causa do preview a tiraria do load balancer
e transformaria uma falha de feature em queda de site. Só `services` decide o
status HTTP.

** ** se o binário empacotado não rodar, instale o ffmpeg do sistema e
aponte `FFMPEG_PATH` para ele; se o preview não for prioridade, desligue com
`VIDEO_PREVIEW_ENABLED=false` — aí `optional.videoPreview` reporta `disabled` e o
log de boot para de reclamar.

---

## Orquestração de IA multi-provider

Nenhum use case fala com um provider direto. Todos passam pelo
`AIOrchestratorService`, que resolve **capacity, rate limit e fallback** em um
único lugar.

**Rota por tarefa** (`ModelRouterService`): análise estruturada vai primeiro para
a OpenAI; geração de copy vai primeiro para a Anthropic. Toda rota termina no
provider `memory`, então nenhuma tarefa fica sem resposta. Provider sem chave
configurada é removido da rota — o Anthropic é opcional e sua ausência não
derruba nem o boot nem a requisição.

**Classificação do erro** (`AIErrorClassifierService`): decide pelo **status
HTTP** (429, 529/503, 5xx, 401/403, 4xx) e só cai na heurística de texto quando
não há status. Cada erro vira duas decisões independentes:

- `retryable` — vale tentar o mesmo modelo de novo
- `fallbackable` — vale tentar o próximo da rota

Um `400` é o único caso que aborta a rota inteira: se o payload é nosso, todo
provider vai recusar igual.

**Backoff**: honra o `Retry-After` do provider quando ele manda um; caso
contrário usa exponencial com jitter (evita workers paralelos repetindo em
uníssono). Espera pedida acima de 4s não é cumprida — trocar de provider é mais
rápido que segurar a requisição.

**Cooldown** (`ProviderHealthRegistry`): depois de saturação, rate limit ou 5xx,
o par `provider/modelo` fica marcado como indisponível por um tempo e é **pulado**
nas próximas chamadas, em vez de custar uma rodada inteira de retries antes do
fallback. Um `Retry-After` de 90s vira um cooldown de 90s. Sucesso limpa a marca.
Erro de payload ou de parse **não** marca nada — repetiria em qualquer provider e
só encurtaria a rota à toa. Se a rota inteira estiver em cooldown, ela é tentada
mesmo assim: cooldown é otimização de latência, nunca causa de indisponibilidade.

O retry das SDKs está desligado (`maxRetries: 0`) de propósito — política de
retry em dois lugares multiplica chamadas e engole o `Retry-After`.

Variáveis:

- `AI_REQUEST_TIMEOUT_MS` (padrão `45000`): teto de **uma** tentativa, para
  sobrar orçamento para o próximo candidato.
- `AI_PROVIDER_COOLDOWN_MS` (padrão `30000`): quanto tempo um provider fica de
  fora depois de se declarar saturado. `Retry-After` tem precedência.

