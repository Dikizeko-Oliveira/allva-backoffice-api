# ALLVA Ads Intelligence Platform Architecture v2.0 — Backend
## Revisão Validada

> **Status:** fonte única de verdade para a implementação · **Data:** 2026-07-30
> **Escopo:** backend (`allva-api`)
> **Substitui:** `allva-ads-intelligence-architecture-v2.md` integralmente.
> **Origem:** revisão arquitetural em dez capítulos, registrada em `chapter-1..10-allva-ads-arch.md`.
> ~110 achados, 14 críticos, 7 decisões de produto fechadas.
> **Numeração de sprints:** prefixo `A2-S*`. Não se confunde com sprints históricos (Phase 1–3,
> Sprint 1–6), já em produção.
>
> **Revisão de implementação (2026-07-30).** Segunda passagem, feita contra o código, verificando se
> o documento vira código sem ambiguidade. **57 pontos resolvidos** — 12 de schema que impediam o
> `prisma validate`, 8 de contradição interna (incluindo um rollup que reintroduzia a dupla contagem
> que o documento existe para eliminar), 10 de invariante sem processo que a mantenha, 8 de
> arquitetura de módulos e 3 de cronograma, mais 16 achados derivados que só apareceram ao escrever
> as correções. As decisões estão registradas em §19 como `D10..D20`; o plano de execução, com a
> rastreabilidade achado → sprint, vive em `PLAN.md` (`A2-S0..A2-S9`).

---

## Sumário

1. [Visão do Produto](#1-visão-do-produto)
2. [Princípios do Produto](#2-princípios-do-produto)
3. [Modelo de Domínio](#3-modelo-de-domínio)
4. [Arquitetura de Entidades](#4-arquitetura-de-entidades)
5. [Arquitetura dos Módulos](#5-arquitetura-dos-módulos)
6. [Vereditos sobre os módulos existentes](#6-vereditos-sobre-os-módulos-existentes)
7. [Endpoints e Contratos](#7-endpoints-e-contratos)
8. [Sincronização](#8-sincronização)
9. [Recommendation Engine](#9-recommendation-engine)
10. [Waste Detector](#10-waste-detector)
11. [Creative Lab](#11-creative-lab)
12. [AI Score](#12-ai-score)
13. [Platform Actions](#13-platform-actions)
14. [Banco de dados e migração](#14-banco-de-dados-e-migração)
15. [Roadmap de implementação](#15-roadmap-de-implementação)
16. [Checklist técnico](#16-checklist-técnico)
17. [Critérios de aceite](#17-critérios-de-aceite)
18. [Riscos arquiteturais](#18-riscos-arquiteturais)
19. [Decisões de produto](#19-decisões-de-produto)
20. [Roadmap de evolução](#20-roadmap-de-evolução)

---

# 1. Visão do Produto

## 1.1 O que a Allva é

A Allva é uma **Ads Intelligence Platform**. Não origina mídia, não substitui o Ads Manager e não
disputa a superfície de criação. Existe para responder cinco perguntas sobre anúncios que **já estão
no ar**:

| # | Pergunta do usuário | Capacidade | Estágio do ciclo |
|---|---|---|---|
| 1 | Onde estou perdendo dinheiro agora? | Waste Detector | `DETECT` |
| 2 | Por que este anúncio está mal? | AI Score + Creative Lab | `SCORE` |
| 3 | O que eu faço a respeito? | Recommendation Engine | `RECOMMEND` |
| 4 | Faça por mim — e confirme que foi feito | Platform Actions + Sync | `APPLY` / `VERIFY` |
| 5 | Funcionou? | Impacto medido | `LEARN` |

**Teste de escopo (estrela-guia).** Nenhuma capacidade entra no produto sem responder a uma dessas
cinco perguntas. A pergunta de review é sempre: *isso ajuda a Allva a encontrar desperdício e
otimizar anúncios?* Se não, não entra — independentemente de ser boa prática.

## 1.2 O que a Allva não é

Fora de escopo, permanentemente — decisão de posicionamento, não backlog:

- criação de campanhas, conjuntos ou anúncios;
- editor de criativo ou construtor de anúncio;
- gestão de públicos, pixels ou catálogos;
- qualquer funcionalidade cuja ausência force o usuário a escolher entre a Allva e o Ads Manager.

A Allva **convive** com o Ads Manager. Campanhas, conjuntos e contas existem no domínio apenas como
contexto estrutural necessário à interoperabilidade com Meta, Google e TikTok.

## 1.3 O diagnóstico

O backend v1 sincroniza anúncios e **nunca os lê**. `ExternalAdsRepositoryInterface` expõe
`upsertMany` e `listByAdAccountId`; o único consumidor em todo o `src/` chama apenas o primeiro.
`external_ads` é *write-only*: a entidade que o produto existe para analisar é a única que nenhuma
feature consulta.

Em paralelo, existe um **domínio ficcional**: o usuário descreve uma campanha hipotética
(`niche`, `region`, `objective`, `budgetAmount`, `durationDays`), a IA devolve um parecer, e nada
toca uma plataforma. Os seis scores que definem o produto vivem ali, presos a campanhas que nunca
foram ao ar. Não há FK, join ou linha de código ligando esse domínio ao mundo sincronizado.

## 1.4 O movimento da v2.0

| | v1 | v2.0 |
|---|---|---|
| Aggregate Root | Campaign (local, ficcional) | **Ad** (real, sincronizado) |
| Unidade de desperdício | `(level, externalEntityId)` | Ad + rollups derivados |
| Alvo de recomendação | tupla de strings | Ad (FK) |
| Scores | efêmeros ou em campanha ficcional | `ad_scores` versionado |
| Ações na plataforma | inexistentes | `AdAction` + write-through |
| Ligações do domínio | strings denormalizadas | foreign keys reais |
| Papel da Campaign | protagonista | contexto read-only |

| # | Movimento | Efeito |
|---|---|---|
| **M1** | `external_ads` → `ads`, com FKs reais | o Ad passa a ser navegável e consultável |
| **M2** | `ad_id` obrigatório em toda inteligência | tudo ancora no anúncio |
| **M3** | Detecção só em nível AD; agregados viram read models | elimina a contagem quádrupla |
| **M4** | `Recommendation` ganha `AdAction[]` executáveis | sai do to-do list, entra no aplicar |
| **M5** | Gateway ganha metade de escrita | fecha o ciclo até `APPLY` |
| **M6** | Todo resultado verificado é persistido e realimenta a calibração | fecha o ciclo em `LEARN` |

## 1.5 O ciclo de valor

```text
         ┌──────────────────── re-observação ─────────────────────────┐
         ▼                                                            │
     INGEST ──► SCORE ──► DETECT ──► RECOMMEND ──► APPLY ──► VERIFY ──┤
     (sync)     (AI       (waste     (ações       (write-   (drift +  │
                Score)     por ad)    tipadas)     through)  impacto) │
                  ▲          ▲            ▲                           │
                  └──────────┴────────────┴────── LEARN ◄─────────────┘
                        (calibração de thresholds, pesos e
                         confiança a partir do resultado medido)

       Ad         Ad         Ad          Ad          Ad        Ad
```

Cada seta é fronteira de módulo. Cada caixa opera sobre o mesmo Aggregate Root.

**`LEARN` não é fase 2.** É o que transforma o histórico de uso em ativo proprietário. Sem ele, a
acurácia no dia 400 é idêntica à do dia 1, e o pré-requisito da automação supervisionada (§20, H3 —
`CONFIRMED > 95%` ao longo de 90 dias) é inalcançável porque ninguém mede.

---

# 2. Princípios do Produto

Normativos. Uma PR que os viole deve ser rejeitada em review.

## P1 — A Allva não origina mídia. No máximo, deriva.

Nenhuma entidade de mídia nasce de um formulário da Allva. Toda entidade de mídia no banco é o
**reflexo** de algo observado numa plataforma externa.

Uma ação tipada pode **derivar** uma entidade nova a partir de um anúncio que já existe —
`DUPLICATE_AD`, ou a recriação forçada pela plataforma em `REPLACE_*` (§13.3). Permitido sob três
condições cumulativas:

1. só como execução de uma `AdAction` com origem declarada (P3);
2. a entidade derivada entra no domínio **exclusivamente pelo sync seguinte**, nunca por construtor;
3. a capability declara `createsEntity: true`, e a linhagem é registrada (`Ad.originAdId`).

**Teste:** nenhuma rota `POST`/`PUT` persiste entidade de mídia. Rotas de ação são permitidas; o
teste verifica que nenhum handler fora do caminho de sync executa `create` sobre `ads`, `campaigns`,
`ad_sets` ou `creatives`.

## P2 — O anúncio é a unidade de verdade.

Campanha e conjunto são contexto de agrupamento herdado das plataformas. Toda métrica, score,
desperdício, recomendação e ação referencia um anúncio. Números por campanha são **derivados**.

**Corolário relacional.** Fenômenos cuja causa está acima ou ao lado do anúncio — saturação de
público, sobreposição de entrega, sufocamento por orçamento sob CBO — são **imputados** ao anúncio
afetado, com o escopo real declarado:

```jsonc
"evidence": {
  "scopeLevel": "AD_SET",
  "relatedAdIds": ["uuid-a", "uuid-b"],
  "attributionRule": "menor performer do conjunto sobreposto"
}
```

**Teste:** (a) toda tabela de inteligência tem `ad_id NOT NULL`; (b) nenhum valor monetário ou score
é persistido acima do anúncio — campanha, conjunto e criativo só aparecem como `GROUP BY` em
leitura; (c) todo achado relacional carrega `scopeLevel` e `relatedAdIds`.

## P3 — Toda ação tem origem declarada, rastreável e auditável.

| `origin` | Significado | `recommendationId` |
|---|---|---|
| `RECOMMENDATION` | aplicação de uma recomendação do motor | obrigatório |
| `WASTE_RESOLUTION` | resolução direta de um `WasteItem` | opcional |
| `USER_DIRECT` | usuário agiu sem recomendação | nulo |
| `REVERT` | reversão de ação anterior | nulo |
| `AUTOMATION_RULE` | regra supervisionada (reservado, v2.2) | nulo |

Exigir que toda ação descenda de uma `Recommendation` obrigaria a fabricar recomendações sintéticas
para atender ações diretas legítimas, contaminando o dataset que P8 usa para medir acurácia.
Procedência declarada preserva a auditabilidade sem corromper o registro.

**Ação direta é sinal, não desvio.** Alta taxa de `USER_DIRECT` sobre um perfil de anúncio indica
recomendação faltante, e é métrica de produto.

**Teste:** nenhuma `AdAction` sem `origin`; toda execução gera `AuditLog` com `origin`;
`origin = RECOMMENDATION` sem `recommendationId` é erro de schema.

## P4 — Determinístico primeiro, IA por cima.

O núcleo de scoring e detecção é puro, testável e reprodutível. A IA enriquece — nunca é
pré-requisito. Um provider fora do ar degrada a qualidade da explicação, não derruba a feature.

## P5 — Escrever na plataforma é mover dinheiro real.

Todo write é auditado, idempotente, reversível quando a plataforma permite, sujeito a kill switch
por organização, e nunca automático sem consentimento explícito registrado.

Ações que derivam entidade nova (P1) ou que a plataforma não desfaz são **irreversíveis por
natureza**: exigem confirmação com escopo explícito e nunca são oferecidas em lote sem dry-run.

## P6 — Multi-plataforma por contrato, não por condicional.

Diferenças entre plataformas vivem em adapters e em `PlatformProfile` (§3.3). O domínio conhece
`AdAction`, não `adcreatives`. Ação não suportada é **declarada**, não falha silenciosamente.

**Teste:** nenhum `if (platform === 'META')` fora de `infrastructure/providers/`. Regra de lint.

## P7 — Nenhum número sem procedência, nenhum diagnóstico sem evidência mínima.

Todo número exposto — score, desperdício, impacto — carrega **versão do algoritmo**, **janela**,
**confiança**, **suficiência de evidência** e **quando foi calculado**.

Abaixo do limiar mínimo de evidência, a Allva **não emite diagnóstico**. Silêncio é resposta válida
e preferível a um falso positivo: mandar pausar um anúncio em learning destrói tanto valor quanto o
desperdício que se queria evitar. Precisão vale mais que cobertura.

Impacto medido é rotulado `observedDelta`, jamais `causedSavings`.

**Teste:** toda resposta com entidade de inteligência carrega
`meta.provenance { algoVersion | detectorVersion | engineVersion, windowDays }`, `asOf`,
`dataMaturity` e `evidenceSufficiency`; todo detector declara seu limiar mínimo e falha em teste se
dispara abaixo dele.

## P8 — O ciclo aprende.

Toda recomendação aplicada é medida, e o resultado é persistido como fato de primeira classe
(`RecommendationOutcome`). Calibração de thresholds, pesos e curvas de confiança usa esse histórico.

A IA pode **propor** calibração; a aplicação é versionada, determinística e replayável sobre o
histórico — o que preserva P4.

**Teste:** toda `Recommendation` em `APPLIED` com janela pós completa tem outcome persistido; nenhuma
alteração de `detectorVersion` ou `algoVersion` é publicada sem relatório de replay.

## P9 — O custo marginal de analisar um anúncio é limitado.

A promessa é observar **todos** os anúncios, todo dia, em todas as plataformas. Recomputo sem
mudança de entrada é proibido (`inputDigest`, `metricsDigest`); chamada de LLM por anúncio-dia sem
mudança de digest é proibida; chamadas de plataforma são orçadas por integração.

## P10 — A identidade do domínio não depende da credencial.

Reconectar, revogar, renovar ou substituir uma integração **nunca** cria entidades novas nem
reinicia histórico. A identidade de conta de anúncios, anúncio, criativo e linhagem ancora em
identificadores estáveis da plataforma sob o escopo da organização; a credencial é um ponteiro
substituível que aponta para a identidade, não o contrário.

Todo o valor diferencial da Allva é longitudinal — série de score, tendência, fadiga, linhagem,
impacto medido. Um evento operacional rotineiro não pode zerar o ativo que o produto leva meses
acumulando. Sem P10, P8 é revogável por acidente.

**Teste:** desconectar e reconectar uma integração preserva `ads.id`, `ads.lineage_id` e as
contagens de `ad_scores`, `waste_items` e `recommendation_outcomes`. Nenhuma unique de entidade de
mídia referencia `integration_id`.

---

# 3. Modelo de Domínio

## 3.1 Mapa de agregados

| Agregado | Raiz | Protege | Ciclo de vida |
|---|---|---|---|
| **Ad** | `Ad` | estado observado, estado desejado, `syncState`, criativo corrente, linhagem | criado e arquivado pelo `sync` |
| **Creative** | `Creative` | conteúdo, `contentHash`, análises | criado pelo `sync` |
| **Integration** | `Integration` | credenciais, escopo, consentimento de escrita, orçamento de chamadas | criado por OAuth |
| **Organization** | `Organization` | tenancy, membros, kill switch, moeda-base | preexistente |

`Campaign` e `AdSet` **não são agregados**. São entidades de contexto: projeções locais da hierarquia
da plataforma, sem comportamento, sem regra de negócio, sem eventos e sem inteligência própria.

> Se alguém precisar adicionar comportamento a `Campaign` ou `AdSet`, é sinal de violação de P2 — o
> comportamento pertence ao anúncio ou é rollup derivado.

## 3.2 Hierarquia canônica

```text
Platform            (Meta | Google | TikTok | …)        — enum + PlatformProfile
   ↓
Integration         credencial OAuth + escopo + orçamento de chamadas
   ↓
AdAccount           conta de anúncios — ÂNCORA DE IDENTIDADE (P10)
   ↓
Campaign            CONTEXTO — read-only, sem inteligência própria
   ↓
AdSet / AdGroup     CONTEXTO — targeting e budget herdados
   ↓
Ad  ◄────────────── AGGREGATE ROOT
   │
   ├── Creative           (agregado próprio; compartilhável entre Ads)
   ├── AdMetricSnapshot[] (série temporal)
   ├── AdScore[]          (série temporal de saúde)
   ├── WasteItem[]        (achados abertos/resolvidos)
   ├── Recommendation[]   (→ AdAction[] → ActionExecution[] → RecommendationOutcome)
   ├── CreativeAnalysis[] (análise por par Creative × Ad)
   └── SyncOperation[]    (histórico de leitura e escrita)
```

## 3.3 `PlatformProfile` — as diferenças declaradas

```typescript
// ads/domain/platform/platform-profile.ts
export type PlatformProfile = {
  platform: Platform;

  hierarchy: {
    hasAdSetLevel: boolean;          // Google/TikTok: true, rotulado "AdGroup"
    adSetLabel: string;
    budgetLevels: ActionLevel[];     // onde o orçamento pode ser alterado
    cboAware: boolean;
  };

  status: {
    toCanonical: Record<string, AdStatus>;
    irreversible: AdStatus[];        // Google: REMOVED
  };

  metrics: {
    available: MetricField[];
    unavailable: Partial<Record<MetricField, string>>;  // campo → motivo declarado
  };

  sync: {
    supportsUpdatedSince: boolean;
    exposesDataTimestamp: boolean;   // alimenta observedAsOf
  };

  identity: {
    recreatesOn: AdActionType[];     // ações que geram novo id na plataforma
  };
};
```

`metrics.unavailable` é o que permite ao scoring declarar honestamente que um componente está
medindo outra coisa — ou não pode ser medido — naquela plataforma (P7). Sem o perfil, o cálculo roda
sobre sinal ausente e reporta confiança alta, que é pior do que não pontuar.

É `PlatformProfile` que torna LinkedIn, Pinterest e Amazon (§20, H4) uma configuração em vez de uma
varredura de código.

## 3.4 Por que o `Ad` é a raiz

**Contra `Creative`:** o criativo não tem estado acionável (não se pausa um criativo, pausa-se um
anúncio); o mesmo criativo em 5 anúncios tem 5 desempenhos, e o score médio não descreve nenhum; e a
métrica de nível CREATIVE é derivada de AD por agregação no provider — projeção com perda de um dado
já disponível em melhor resolução.

**Contra `AdSet`** — o candidato mais forte, já que orçamento, público e fase de aprendizado vivem no
conjunto no Meta:

1. **A unidade de atribuição de desperdício é o anúncio.** Dois anúncios no mesmo conjunto podem ter
   desempenho oposto; só um merece ser pausado. Com raiz em `AdSet`, a pergunta nº 1 do produto
   perde resposta.
2. **O criativo, objeto central da análise, pende do anúncio.**
3. **A ação recai sobre o anúncio** — sete das treze ações de §13.1 são de nível AD.

**Regra de imputação de escopo.** Componentes e achados cujo escopo real está acima do anúncio —
`learningStability`, `saturationRisk`, `AUDIENCE_SATURATION`, `OVERLAPPING_DELIVERY`,
`BUDGET_STARVATION` sob CBO — são **calculados no seu escopo real e imputados ao anúncio**, sempre
declarando `scopeLevel` e `relatedAdIds`. Nunca armazenados como inteligência do conjunto.

## 3.5 Fronteira e invariantes do agregado

O agregado **contém** (mesma transação): estado observado, estado desejado, vínculo com criativo
corrente, `syncState`, identidade de linhagem.

O agregado **referencia** (consistência eventual): `Campaign`, `AdSet`, `Creative`, e os filhos
analíticos escritos por workers assíncronos.

| # | Invariante | Garantia |
|---|---|---|
| **I1** | Nada de inteligência existe sem `ad_id` válido | `NOT NULL` + FK + `ON DELETE CASCADE` |
| **I2** | **No máximo uma escrita em voo por alvo** `(entityType, entityId)` | índice único parcial sobre execuções não terminais + `version` (lock otimista) no `Ad` |
| **I3** | `observedStatus` só é escrito pelo `sync`; `desiredStatus` só por `platform-actions` | propriedade de campo (§5.4) + teste de arquitetura |
| **I4** | `syncState` só transita segundo a máquina de estados | transições num serviço de domínio puro; nenhuma atribuição direta |
| **I5** | Anúncio arquivado não aceita ações nem gera recomendações | guarda no use case sobre `archivedAt` |
| **I6** | Todo anúncio pertence a exatamente uma linhagem | `lineageId NOT NULL`, default = próprio `id` |

**I2 é a invariante central.** Sem ela, um lote de `POST /ads/actions/batch` sobreposto a um apply
individual resulta em *last write wins* no `desiredStatus`: uma execução perde seu estado desejado e
a reconciliação emite `ad.drifted` para um anúncio que não sofreu drift. O produto passaria a
alertar sobre divergências que ele mesmo criou, corroendo o único sinal que comprova ao usuário que
a ação foi aplicada.

Ela vale por **alvo da ação**, não por anúncio: ações em `AD_SET` e `CAMPAIGN` vindas de anúncios
diferentes competem pela mesma entidade.

**Máquina de estados de `syncState`:**

```text
                            ┌──────────► UNREACHABLE ◄────────────┐
                            │  (integração expirada/desconectada) │
   STALE ────ingest────► IN_SYNC ────ação aceita────► PENDING_WRITE│
     ▲                    ▲   ▲                            │      │
     │                    │   └────verificação CONFIRMED───┤      │
     └───SLA vencido──────┘                                │      │
                        DRIFTED ◄────escada esgotada───────┘      │
                           │                                      │
                           └────reconciliação bem-sucedida────────┘
```

| Transição | Módulo autorizado |
|---|---|
| `* → IN_SYNC` · `* → STALE` · `* → DRIFTED` · `* → UNREACHABLE` | `sync` |
| `IN_SYNC \| STALE → PENDING_WRITE` | `platform-actions` (única que lhe cabe) |

## 3.6 Identidade e linhagem

`ad_id` identifica um registro na plataforma. Não identifica o **anúncio como intenção
publicitária**: `REPLACE_COPY`, `REPLACE_CTA`, `REPLACE_CREATIVE` (com `requiresRecreate`) e
`DUPLICATE_AD` produzem id novo — e a identidade quebra exatamente na aplicação das recomendações
criativas, as mais valiosas do catálogo.

- Todo `Ad` tem `lineageId NOT NULL`, default igual ao próprio `id`.
- Anúncio derivado por ação da Allva **herda** o `lineageId` da origem e registra `originAdId` e
  `originActionExecutionId`.
- Consultas de série — score, métricas, impacto pré/pós — agrupam por `lineageId`.
- `Creative.contentHash` faz outro trabalho: reconhecer o mesmo **conteúdo** entre contas e
  plataformas (§20, H2), não a continuidade do mesmo anúncio.

---

# 4. Arquitetura de Entidades

## 4.1 Regras transversais

### R-I — Identidade ancora em `AdAccount` (P10)

```prisma
model AdAccount {
  id                String  @id @default(uuid())
  accountId         String  @map("account_id")
  organizationId    String  @map("organization_id")
  platform          Platform
  externalAccountId String  @map("external_account_id")
  name              String

  integrationId String? @map("integration_id")      // credencial CORRENTE, substituível
  currency      String                               // fonte de verdade monetária
  timezone      String                               // fonte de verdade temporal
  attributionSetting String? @map("attribution_setting")

  /// Janela de atribuição da conta, lida da plataforma. A janela de re-declaração é
  /// max(env, attributionWindowDays): duas contas da MESMA organização podem ter 7 e 28.
  attributionWindowDays Int? @map("attribution_window_days")
  restatementWindowDays Int  @default(14) @map("restatement_window_days")

  // --- saúde de sincronização: é isto que a tabela de degradação de §8.7 lê ---
  syncHealth               AdAccountSyncHealth @default(HEALTHY) @map("sync_health")
  syncHealthReason         String?   @map("sync_health_reason")
  unreachableSince         DateTime? @map("unreachable_since")
  lastSuccessfulFullSyncAt DateTime? @map("last_successful_full_sync_at")

  discoveredAt   DateTime  @default(now()) @map("discovered_at")
  lastFullSyncAt DateTime? @map("last_full_sync_at")

  organization Organization @relation(fields: [organizationId], references: [id])
  integration  Integration? @relation(fields: [integrationId], references: [id])
  campaigns    Campaign[]
  adSets       AdSet[]
  ads          Ad[]
  creatives    Creative[]
  syncOperations SyncOperation[]
  quarantine     SyncQuarantine[]

  @@unique([organizationId, platform, externalAccountId])
  @@index([integrationId])
  @@index([organizationId, syncHealth])
  @@map("ad_accounts")
}

enum AdAccountSyncHealth { HEALTHY  DEGRADED  UNREACHABLE }
```

Reconectar **repontua** `adAccount.integrationId`. Nenhuma entidade filha é recriada.
Uniques da hierarquia: `Campaign`, `AdSet`, `Ad` e `Creative` são únicos por
`(adAccountId, externalXId)` — **nunca** por `integrationId`.

### R-H — A saúde é da conta, não do anúncio

`Ad.syncState` descreve **um anúncio**. Mas a guarda de arquivamento (§8.2, passo 9), a
reconciliação de frescor (§8.5c), o rebind (§8.6) e a tabela de degradação (§8.7) decidem sobre a
**conta inteira** — "não conseguimos ver tudo" não é propriedade de um anúncio. Sem um estado de
conta, a correção central do sync não teria onde registrar seu veredito.

| Estado | Significado | Ingest | Scoring · Detecção | Ações | Arquivamento |
|---|---|---|---|---|---|
| `HEALTHY` | último ingest completo, dentro do SLA | roda | rodam | permitidas | permitido |
| `DEGRADED` | ingest parcial, ou métrica fora do SLA | roda | **pausam** | permitidas | **proibido** |
| `UNREACHABLE` | credencial expirada, escopo perdido, resposta incompleta | falha e reporta | **pausam** | **bloqueadas** | **proibido** |

### R-T — Tenancy

`organizationId` é **NOT NULL** em `Ad`, em todas as tabelas de inteligência e nas de contexto.
Redundância deliberada (R9) e pré-requisito de RLS.

### R-M — Moeda: dupla persistência

Todo valor monetário é persistido **duas vezes**: original (moeda da conta) e normalizado
(moeda-base da organização).

| Grandeza | Original | Normalizado |
|---|---|---|
| gasto | `spend` + `currency` | `spendBase` + `baseCurrency` |
| receita | `revenue` | `revenueBase` |
| desperdício | `incurredAmount` | `incurredAmountBase` |
| impacto | `impact` | `impactBase` |

| # | Regra | Razão |
|---|---|---|
| **M1** | A inteligência lê **apenas** o normalizado. Limiares absolutos são declarados em moeda-base. A apresentação escolhe; visão de anúncio e de plataforma mostra o original. | comparabilidade |
| **M2** | A taxa é fixada na ingestão e **nunca** recalculada. `fxRate`, `fxAsOf`, `fxSource` na linha. | converter na leitura faria o desperdício histórico variar diariamente sem nada acontecer (P7) |
| **M3** | Parâmetros de ação de orçamento vão à plataforma na **moeda da conta**, nunca na base. Validação por tipo rejeita divergência. | enviar base moveria dinheiro real na quantia errada (P5) |
| **M4** | Medição de impacto converte as duas janelas pela **mesma** taxa, a de `appliedAt`. | senão a variação cambial vira "efeito da recomendação" no dataset de P8 |

Taxa indisponível ⇒ `normalizationPending = true`, linha excluída das agregações de inteligência e
`evidenceSufficiency` reduzida — nunca bloqueia a ingestão.

```prisma
model Organization {
  // … inalterado
  baseCurrency   String  @default("BRL") @map("base_currency")
  actionsEnabled Boolean @default(false) @map("actions_enabled")   // kill switch (D4)

  currencyState         OrgCurrencyState @default(STABLE) @map("currency_state")
  previousBaseCurrency  String?          @map("previous_base_currency")
  baseCurrencyChangedAt DateTime?        @map("base_currency_changed_at")
}

enum OrgCurrencyState { STABLE  RECOMPUTING_CURRENCY }

/// Coletada SEMPRE contra FX_PIVOT_CURRENCY (padrão USD); qualquer par sai por taxa cruzada.
/// Acessada exclusivamente pelo Currency Normalization Service.
model FxRate {
  id           String   @id @default(uuid())
  date         DateTime @db.Date
  fromCurrency String   @map("from_currency")
  toCurrency   String   @map("to_currency")
  rate         Decimal  @db.Decimal(18, 8)
  source       String
  fetchedAt    DateTime @default(now()) @map("fetched_at")

  @@unique([date, fromCurrency, toCurrency, source])
  @@index([fromCurrency, toCurrency, date])
  @@map("fx_rates")
}

/// D3.4 — o recomputo de moeda-base. Sem esta tabela, RECOMPUTING_CURRENCY não tem
/// onde registrar progresso, escopo nem retomada, e a degradação de §8.7 fica sem lastro.
model CurrencyMigration {
  id             String @id @default(uuid())
  organizationId String @map("organization_id")
  fromCurrency   String @map("from_currency")
  toCurrency     String @map("to_currency")

  status CurrencyMigrationStatus @default(PENDING)
  requestedByAccountId String   @map("requested_by_account_id")
  requestedAt          DateTime @default(now()) @map("requested_at")
  startedAt            DateTime? @map("started_at")
  completedAt          DateTime? @map("completed_at")

  /// Cancelar só é seguro ANTES de escrever. De RUNNING, o pedido é intenção:
  /// o worker o observa no próximo checkpoint e termina em ROLLED_BACK.
  cancellationRequestedAt   DateTime? @map("cancellation_requested_at")
  cancellationRequestedById String?   @map("cancellation_requested_by_id")

  progress  Json?   // { tabela -> { lastId, rowsDone, rowsTotal } } — retomada
  rowCounts Json?   // relatório final; payload de organization.base_currency.recomputed
  correlationId String? @map("correlation_id")
  errorMessage  String? @map("error_message")

  @@index([organizationId, status])
  @@map("currency_migrations")
}

enum CurrencyMigrationStatus { PENDING  RUNNING  COMPLETED  FAILED  CANCELLED  ROLLED_BACK }

/// Configuração por organização. Sem ela, "versão ativa" vira constante de código,
/// D8 ("janela configurável por org, gravada") não é cumprível e P9 não tem teto.
model OrganizationAdsSettings {
  organizationId String @id @map("organization_id")

  scoringWindowDays            Int    @default(14) @map("scoring_window_days")          // D8
  activeAlgoVersion            String @default("deterministic-v2") @map("active_algo_version")
  activeDetectorProfileVersion String @default("waste-thresholds-v1") @map("active_detector_profile_version")

  /// Por TAREFA, não global: narrativa, sugestões criativas e título de recomendação
  /// evoluem em ritmos diferentes. Chave = AiTaskType.
  /// { "ad-narrative": "v3", "creative-suggestions": "v1", "reco-title": "v2" }
  activePromptVersions Json @default("{}") @map("active_prompt_versions")

  llmDailyBudgetBase Decimal? @map("llm_daily_budget_base") @db.Decimal(14, 4)  // P9
  actionDailyCap     Int?     @map("action_daily_cap")                          // §13.5

  updatedAt DateTime @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id])
  @@map("organization_ads_settings")
}
```

```sql
-- No máximo um recomputo ativo por organização.
CREATE UNIQUE INDEX currency_migrations_active_unique
  ON currency_migrations (organization_id) WHERE status IN ('PENDING','RUNNING');
```

> **O recomputo não viola M2.** M2 congela a taxa **da linha**: `fxRate`, `fxAsOf` e `fxSource` de
> um snapshot nunca são reescritos. O que a migração recalcula é o valor `*Base`, usando a taxa
> **histórica da data daquela linha** contra a nova moeda-base — nunca a taxa de hoje. Sem essa
> distinção explícita, D3.4 e M2 pareceriam se contradizer, e a implementação escolheria errado.
>
> A troca de moeda-base é causa de `seriesDiscontinuity` (§12.5): toda série monetária muda de
> unidade sem que nada tenha acontecido com o anúncio.

## 4.2 Contexto — `Campaign` e `AdSet`

```prisma
model Campaign {
  id                 String    @id @default(uuid())
  adAccountId        String    @map("ad_account_id")
  organizationId     String    @map("organization_id")
  integrationId      String    @map("integration_id")
  platform           Platform
  externalCampaignId String    @map("external_campaign_id")
  name               String
  status             String?
  objective          String?
  dailyBudget        Decimal?  @map("daily_budget") @db.Decimal(14, 4)
  lifetimeBudget     Decimal?  @map("lifetime_budget") @db.Decimal(14, 4)
  currency           String
  startedAt          DateTime? @map("started_at")
  endedAt            DateTime? @map("ended_at")
  metadata           Json?
  lastSyncedAt       DateTime  @default(now()) @map("last_synced_at")
  archivedAt         DateTime? @map("archived_at")

  adAccount AdAccount @relation(fields: [adAccountId], references: [id])
  adSets    AdSet[]
  ads       Ad[]

  @@unique([adAccountId, externalCampaignId])
  @@index([organizationId])
  @@map("campaigns")
}

model AdSet {
  id               String   @id @default(uuid())
  adAccountId      String   @map("ad_account_id")
  organizationId   String   @map("organization_id")
  campaignId       String   @map("campaign_id")        // FK real
  platform         Platform
  externalAdSetId  String   @map("external_ad_set_id")
  name             String
  status           String?
  optimizationGoal String?  @map("optimization_goal")
  billingEvent     String?  @map("billing_event")
  dailyBudget      Decimal? @map("daily_budget") @db.Decimal(14, 4)
  lifetimeBudget   Decimal? @map("lifetime_budget") @db.Decimal(14, 4)
  targeting        Json?
  archivedAt       DateTime? @map("archived_at")

  adAccount AdAccount @relation(fields: [adAccountId], references: [id])
  campaign  Campaign  @relation(fields: [campaignId], references: [id])
  ads       Ad[]

  @@unique([adAccountId, externalAdSetId])
  @@index([campaignId])
  @@map("ad_sets")
}
```

> **Toda coluna `*Id` da hierarquia é FK declarada, nunca junção lógica.** `AdSet.adAccountId` e
> `Creative.adAccountId` são únicos por conta e precisam da relação Prisma correspondente — sem ela
> o schema não gera, e o `@@unique` fica apoiado numa coluna que o ORM não sabe navegar (§16.1).

> **Invariante de coerência.** Quando `Ad.adSetId` não é nulo, `Ad.campaignId == AdSet.campaignId`.
> Garantida por FK composta ou por job diário de reconciliação. Sem ela, o rollup por campanha e o
> por conjunto contam populações diferentes sem erro visível.
>
> **A FK canônica do `Ad` é `campaignId`** (NOT NULL). `adSetId` é nullable por design, para
> plataformas sem o nível intermediário.

## 4.3 O Aggregate Root

```prisma
model Ad {
  id             String  @id @default(uuid())
  accountId      String  @map("account_id")
  organizationId String  @map("organization_id")

  adAccountId   String   @map("ad_account_id")
  integrationId String   @map("integration_id")
  platform      Platform
  externalAdId  String   @map("external_ad_id")

  campaignId String  @map("campaign_id")
  adSetId    String? @map("ad_set_id")
  creativeId String? @map("creative_id")
  name       String

  // --- identidade de linhagem (§3.6) ---
  lineageId               String  @map("lineage_id")
  originAdId              String? @map("origin_ad_id")
  originActionExecutionId String? @map("origin_action_execution_id")

  // --- controle de concorrência (I2) ---
  version Int @default(0)

  // --- estado observado (fonte: sync) ---
  observedStatus    AdStatus  @default(UNKNOWN) @map("observed_status")
  observedRawStatus String?   @map("observed_raw_status")
  observedAsOf      DateTime? @map("observed_as_of")     // instante DO DADO na plataforma

  // --- estado desejado (fonte: platform-actions) ---
  desiredStatus      AdStatus? @map("desired_status")
  desiredStatusSetAt DateTime? @map("desired_status_set_at")

  // --- sincronização: dois relógios de frescor ---
  syncState           AdSyncState @default(STALE) @map("sync_state")
  syncStateAt         DateTime?   @map("sync_state_at")
  driftDetails        Json?       @map("drift_details")
  lastStructureSyncAt DateTime?   @map("last_structure_sync_at")
  lastMetricsSyncAt   DateTime?   @map("last_metrics_sync_at")

  // --- maturidade do dado (dono: sync — é propriedade da janela × conta) ---
  dataMaturity DataMaturity? @map("data_maturity")

  // --- denormalizações de leitura POR VALOR (nunca fonte de verdade) ---
  currentScoreId           String?   @map("current_score_id")   // coluna simples, sem FK
  currentAiScore           Float?    @map("current_ai_score")
  currentScoreConfidence   Float?    @map("current_score_confidence")
  currentScoreCoverage     Float?    @map("current_score_coverage")   // coverageRatio (§12.2)
  scoreDelta7d             Float?    @map("score_delta_7d")
  scoreAsOf                DateTime? @map("score_as_of")
  openWasteCount           Int       @default(0) @map("open_waste_count")
  openWasteAmount          Decimal   @default(0) @map("open_waste_amount") @db.Decimal(14, 4)
  openWasteCurrency        String?   @map("open_waste_currency")
  openWasteAmountBase      Decimal   @default(0) @map("open_waste_amount_base") @db.Decimal(14, 4)
  avoidableDailyAmountBase Decimal   @default(0) @map("avoidable_daily_amount_base") @db.Decimal(14, 4)
  wasteAsOf                DateTime? @map("waste_as_of")

  metadata     Json?
  firstSeenAt  DateTime  @default(now()) @map("first_seen_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")
  archivedAt   DateTime? @map("archived_at")

  adAccount AdAccount @relation(fields: [adAccountId], references: [id])
  campaign  Campaign  @relation(fields: [campaignId], references: [id])
  adSet     AdSet?    @relation(fields: [adSetId], references: [id])
  creative  Creative? @relation(fields: [creativeId], references: [id])

  snapshots        AdMetricSnapshot[]
  scores           AdScore[]
  wasteItems       WasteItem[]
  recommendations  Recommendation[]
  actions          AdAction[]
  syncOperations   SyncOperation[]
  creativeAnalyses CreativeAnalysis[]

  @@unique([adAccountId, externalAdId])
  @@index([organizationId, currentAiScore, id])
  @@index([organizationId, scoreDelta7d, id])
  @@index([organizationId, avoidableDailyAmountBase(sort: Desc), id])
  @@index([organizationId, syncState])
  @@index([organizationId, campaignId])
  @@index([lineageId])
  @@index([adAccountId, archivedAt])
  @@map("ads")
}

enum AdStatus { ACTIVE  PAUSED  ARCHIVED  DELETED  PENDING_REVIEW  DISAPPROVED  UNKNOWN }
enum AdSyncState { IN_SYNC  PENDING_WRITE  DRIFTED  STALE  UNREACHABLE }
enum DataMaturity { IMMATURE  SETTLING  MATURE }
```

> **Índices declaram nome de campo, não nome de coluna.** O `@map` faz a tradução; misturar as duas
> convenções dentro de `@@index` é erro de `prisma validate`. A direção `Desc` do ranking pertence à
> declaração Prisma, não só ao SQL de §14.4 — senão o índice criado não é o índice usado.
>
> `openWasteAmount` é o **máximo** entre os itens abertos do anúncio (§10.6), e a única parcela
> somável em rollup. Rankings somam `avoidable_daily_amount_base` — o número acionável.
>
> **`currentScoreCoverage` e `dataMaturity` são denormalizados por necessidade, não por conveniência.**
> §12.4 barra da ordenação quem está abaixo do piso de cobertura e §7.1 filtra por maturidade: sem as
> duas colunas em `ads`, `GET /ads` precisaria de join na série para aplicar os próprios pisos, e o
> p95 < 400 ms de §17.2 fica inalcançável. Os donos são distintos — `ad-scoring` escreve a cobertura,
> `sync` escreve a maturidade (§5.4).

## 4.4 Métricas e criativos

```prisma
model AdMetricSnapshot {
  id             String   @id @default(uuid())
  adId           String   @map("ad_id")
  organizationId String   @map("organization_id")
  adAccountId    String   @map("ad_account_id")
  platform       Platform
  date           DateTime          @db.Date
  granularity    MetricGranularity @default(DAY)

  campaignId String  @map("campaign_id")
  adSetId    String? @map("ad_set_id")
  creativeId String? @map("creative_id")

  spend       Decimal @default(0) @db.Decimal(14, 4)
  impressions Int     @default(0)
  clicks      Int     @default(0)
  conversions Int     @default(0)
  revenue     Decimal @default(0) @db.Decimal(14, 4)
  reach       Int?
  frequency   Float?
  videoViews  Int?    @map("video_views")
  engagement  Int?
  thumbstopRate Float? @map("thumbstop_rate")
  holdRate      Float? @map("hold_rate")

  // sinais de feedback negativo — necessários para NegativeFeedbackRisk real
  hides      Int? @map("hides")
  hideAllFor Int? @map("hide_all_for")
  reports    Int?
  unlikes    Int?

  // moeda: dupla persistência (R-M)
  currency     String
  baseCurrency String  @map("base_currency")
  spendBase    Decimal @default(0) @map("spend_base")   @db.Decimal(14, 4)
  revenueBase  Decimal @default(0) @map("revenue_base") @db.Decimal(14, 4)
  fxRate       Decimal?  @map("fx_rate") @db.Decimal(18, 8)
  fxAsOf       DateTime? @map("fx_as_of") @db.Date
  fxSource     String?   @map("fx_source")
  normalizationPending Boolean @default(false) @map("normalization_pending")

  // tempo e atribuição
  accountTimezone     String  @map("account_timezone")
  attributionSetting  String? @map("attribution_setting")
  seriesDiscontinuity Boolean @default(false) @map("series_discontinuity")

  syncedAt DateTime @default(now()) @map("synced_at")

  ad Ad @relation(fields: [adId], references: [id], onDelete: Cascade)

  @@unique([adId, date, granularity])
  @@index([organizationId, date])
  @@index([creativeId, date])
  @@index([campaignId, date])
  @@map("ad_metric_snapshots")
}
```

> **Ratios são derivados, não armazenados.** `ctr`, `cpc`, `cpa`, `roas` saem das colunas base.
> Persistí-los é convite a inconsistência quando linhas são agregadas.
>
> **Uma granularidade só.** Nível CAMPAIGN/ADSET não existe no armazenamento; rollups são `SUM` com
> `GROUP BY`. Isso elimina a classe inteira de bugs de dupla contagem.
>
> **Tabela particionada por faixa de `date` desde a criação** (§14.3).

```prisma
model Creative {
  id                 String  @id @default(uuid())
  adAccountId        String  @map("ad_account_id")
  organizationId     String  @map("organization_id")
  platform           Platform
  externalCreativeId String  @map("external_creative_id")
  name           String?
  title          String?
  body           String?
  callToAction   String?  @map("call_to_action")
  format         String?
  durationMs     Int?     @map("duration_ms")
  width          Int?
  height         Int?
  thumbnailUrl   String?  @map("thumbnail_url")
  videoUrl       String?  @map("video_url")
  imageUrl       String?  @map("image_url")
  landingPageUrl String?  @map("landing_page_url")

  contentHash String? @map("content_hash")   // fingerprint de conteúdo

  metadata     Json?
  lastSyncedAt DateTime  @default(now()) @map("last_synced_at")
  archivedAt   DateTime? @map("archived_at")

  adAccount AdAccount @relation(fields: [adAccountId], references: [id])
  ads       Ad[]
  analyses  CreativeAnalysis[]

  @@unique([adAccountId, externalCreativeId])
  @@index([organizationId])
  @@index([contentHash])
  @@map("creatives")
}
```

## 4.5 Inteligência

```prisma
model AdScore {
  id             String @id @default(uuid())
  adId           String @map("ad_id")
  organizationId String @map("organization_id")
  creativeId     String? @map("creative_id")     // o criativo VIGENTE ao pontuar

  scoredAt    DateTime @default(now()) @map("scored_at")
  scoreDate   DateTime @map("score_date") @db.Date
  windowStart DateTime @map("window_start") @db.Date
  windowEnd   DateTime @map("window_end")   @db.Date
  windowDays  Int      @map("window_days")
  algoVersion String   @map("algo_version")
  priorWeight Float    @map("prior_weight")

  aiScore           Float @map("ai_score")
  aiConfidence      Float @map("ai_confidence")
  componentCoverage Float @map("component_coverage")

  /// Cada componente persiste value (escala nativa), normalizedValue (0..100 ↑),
  /// confidence, available, reasons. Estrutura tipada em JSON validado por schema.
  components Json

  /// Contexto declarado, FORA do composto: saturationRisk com scopeLevel = AD_SET
  context Json?

  seriesDiscontinuity String? @map("series_discontinuity")  // motivo, quando houver
  frozenAt            DateTime? @map("frozen_at")           // ad pausado/arquivado

  inputDigest String  @map("input_digest")
  aiNarrative String? @map("ai_narrative")
  aiProvider  String? @map("ai_provider")
  aiModel     String? @map("ai_model")

  ad Ad @relation(fields: [adId], references: [id], onDelete: Cascade)

  @@unique([adId, scoreDate, algoVersion, scoredAt])
  @@index([adId, scoreDate(sort: Desc)])
  @@index([organizationId, algoVersion, scoreDate])
  @@map("ad_scores")
}
```

```prisma
model WasteItem {
  id             String  @id @default(uuid())
  adId           String  @map("ad_id")
  organizationId String  @map("organization_id")
  accountId      String  @map("account_id")
  creativeId     String? @map("creative_id")

  findingKind FindingKind   @default(WASTE) @map("finding_kind")   // WASTE | OPPORTUNITY
  type        FindingType
  status      WasteStatus   @default(OPEN)
  priority    WastePriority @default(MEDIUM)
  windowDays  Int           @map("window_days")

  // duas grandezas, nunca uma (§10.1)
  incurredAmount       Decimal @default(0) @map("incurred_amount")        @db.Decimal(14, 4)
  incurredAmountBase   Decimal @default(0) @map("incurred_amount_base")   @db.Decimal(14, 4)
  avoidableDailyAmount Decimal @default(0) @map("avoidable_daily_amount") @db.Decimal(14, 4)
  avoidableDailyBase   Decimal @default(0) @map("avoidable_daily_base")   @db.Decimal(14, 4)
  currency     String
  baseCurrency String @map("base_currency")

  diagnosis              String
  evidence               Json     // thresholds, observed, scopeLevel, relatedAdIds, attributionRule
  evidenceSufficiency    String   @map("evidence_sufficiency")
  scopeLevel             String   @map("scope_level")
  dataMaturity           String   @map("data_maturity")
  detectorVersion        String   @map("detector_version")
  detectorProfileVersion String   @map("detector_profile_version")
  detectorGeneration     Int      @default(2) @map("detector_generation")

  fingerprint      String   @map("fingerprint")   // sha256(adId|type) — SEM versão
  occurrences      Int      @default(1)
  detectedAt       DateTime @default(now()) @map("detected_at")
  lastSeenAt       DateTime @default(now()) @map("last_seen_at")
  staleObservation Boolean  @default(false) @map("stale_observation")

  resolvedAt     DateTime?            @map("resolved_at")
  resolutionKind WasteResolutionKind? @map("resolution_kind")
  resolvedByActionExecutionId String? @map("resolved_by_action_execution_id")
  resolvedByAccountId         String? @map("resolved_by_account_id")

  ad                       Ad               @relation(fields: [adId], references: [id], onDelete: Cascade)
  resolvedByActionExecution ActionExecution? @relation("WasteResolution", fields: [resolvedByActionExecutionId], references: [id], onDelete: SetNull)
  recommendations          RecommendationWasteItem[]

  @@index([organizationId, findingKind, status, priority, id])
  @@index([adId, status])
  @@map("waste_items")
}

/// Reduzido a dois valores DE PROPÓSITO. A nuance vive inteira em WasteResolutionKind;
/// mantê-la nos dois enums é a duplicação que produz divergência entre a view e a listagem.
enum WasteStatus { OPEN  RESOLVED }

enum FindingKind { WASTE  OPPORTUNITY }

enum FindingType {
  ZERO_CONVERSIONS  LOW_CTR  HIGH_CPA  LOW_ROAS
  CREATIVE_FATIGUE  AUDIENCE_SATURATION  LEARNING_INSTABILITY
  NEGATIVE_FEEDBACK  OVERLAPPING_DELIVERY
  BUDGET_STARVATION            // findingKind = OPPORTUNITY
}

enum WasteResolutionKind {
  RESOLVED_BY_ACTION
  RESOLVED_EXTERNALLY
  RESOLVED_BY_RESTATEMENT      // dado re-declarado desfez — falso positivo, não acerto
  DISMISSED
  STALE
  SUPERSEDED_BY_DETECTOR       // mudança de LÓGICA, nunca de limiar
}
```

```sql
-- Índice parcial: Prisma não suporta nativamente. Migração raw, NORMATIVA.
-- Sem ele, múltiplos itens ABERTOS com o mesmo fingerprint são permitidos
-- (em Postgres, NULL é distinto de NULL em unique composta).
CREATE UNIQUE INDEX waste_items_open_unique
  ON waste_items (fingerprint) WHERE resolved_at IS NULL;

-- "Aberto" tem DUAS representações: status e resolved_at. A view open_waste e o índice
-- acima leem resolved_at; o índice de listagem lê status. Sem o CHECK, uma linha
-- RESOLVED com resolved_at NULL conta como aberta na view e resolvida na lista — em
-- silêncio, e para sempre.
ALTER TABLE waste_items ADD CONSTRAINT waste_items_status_coherent
  CHECK ((status = 'OPEN') = (resolved_at IS NULL));
ALTER TABLE waste_items ADD CONSTRAINT waste_items_resolution_coherent
  CHECK ((resolved_at IS NULL) = (resolution_kind IS NULL));
```

```prisma
model Recommendation {
  id             String @id @default(uuid())
  adId           String @map("ad_id")
  organizationId String @map("organization_id")
  accountId      String @map("account_id")

  kind      RecommendationKind
  advisory  Boolean @default(false)          // remédio fora do escopo da Allva
  outOfScopeReason String? @map("out_of_scope_reason")
  title     String
  rationale String
  guidance  String?

  /// Impacto ESTIMADO por tipo, nunca somados (§9.7).
  /// [{ type, estimatedBase, horizonDays, confidence }]
  /// O realizado NÃO mora aqui: é lido de RecommendationOutcome por join. Duas casas
  /// para o mesmo número divergem em silêncio, e a que erra é sempre a projeção.
  impacts Json

  /// Qual dos tipos de impacto o outcome vai medir. Definido na geração, por kind (§9.7).
  primaryImpactType OutcomeDeltaKind @map("primary_impact_type")

  currency     String
  baseCurrency String @map("base_currency")

  priority RecommendationPriority @default(MEDIUM)
  status   RecommendationStatus   @default(NEW)
  blockedReason  String?  @map("blocked_reason")
  conflictWithId String?  @map("conflict_with_id")

  engineVersion String    @map("engine_version")
  evidence      Json?
  evidenceAsOf  DateTime  @map("evidence_as_of")
  expiresAt     DateTime? @map("expires_at")
  aiNarrative   String?   @map("ai_narrative")

  supersededById String?         @map("superseded_by_id")
  supersededBy   Recommendation? @relation("RecoLineage", fields: [supersededById], references: [id])
  supersedes     Recommendation[] @relation("RecoLineage")

  appliedAt     DateTime? @map("applied_at")
  dismissedAt   DateTime? @map("dismissed_at")
  dismissReason String?   @map("dismiss_reason")

  ad         Ad         @relation(fields: [adId], references: [id], onDelete: Cascade)
  wasteItems RecommendationWasteItem[]
  actions    AdAction[]
  outcome    RecommendationOutcome?

  @@index([organizationId, status, priority])
  @@index([adId, status])
  @@map("recommendations")
}

enum RecommendationStatus {
  NEW  ACKNOWLEDGED  APPLYING  APPLIED  FAILED
  DISMISSED  EXPIRED  SUPERSEDED  DEFERRED_BY_CONFLICT
}

enum RecommendationKind {
  PAUSE_UNDERPERFORMING_AD  REFRESH_FATIGUED_CREATIVE  IMPROVE_WEAK_HOOK
  REPLACE_CTA  MITIGATE_NEGATIVE_FEEDBACK  REDUCE_BUDGET_HIGH_CPA
  STABILIZE_LEARNING  CONSOLIDATE_OVERLAP  EXPAND_AUDIENCE  SCALE_WINNING_AD
}

/// Junção N:N — um plano coerente responde a vários sinais do mesmo anúncio (§9.4)
model RecommendationWasteItem {
  recommendationId String @map("recommendation_id")
  wasteItemId      String @map("waste_item_id")

  recommendation Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)
  wasteItem      WasteItem      @relation(fields: [wasteItemId], references: [id], onDelete: Cascade)

  @@id([recommendationId, wasteItemId])
  @@map("recommendation_waste_items")
}

model RecommendationSuppression {
  id                 String @id @default(uuid())
  organizationId     String @map("organization_id")
  kind               RecommendationKind
  scope              SuppressionScope          // AD | AD_SET | CAMPAIGN | ORGANIZATION
  scopeId            String? @map("scope_id")
  reason             String
  createdByAccountId String  @map("created_by_account_id")
  createdAt          DateTime @default(now()) @map("created_at")
  expiresAt          DateTime? @map("expires_at")   // null = permanente

  @@index([organizationId, kind, scope, scopeId])
  @@map("recommendation_suppressions")
}

/// P8 — o fato que fecha o ciclo. Sem esta tabela, LEARN não existe.
model RecommendationOutcome {
  id               String @id @default(uuid())
  recommendationId String @unique @map("recommendation_id")
  adId             String @map("ad_id")
  lineageId        String @map("lineage_id")     // segue a linhagem, não o ad_id
  organizationId   String @map("organization_id")

  /// A linha nasce em APPLY, com o PRÉ preenchido, e é completada dias depois.
  status OutcomeStatus @default(PENDING_MEASUREMENT)

  appliedAt  DateTime  @map("applied_at")
  windowDays Int       @map("window_days")
  measuredAt DateTime? @map("measured_at")

  currency     String
  baseCurrency String  @map("base_currency")
  fxRateFixed  Decimal @map("fx_rate_fixed") @db.Decimal(18, 8)   // M4: taxa de appliedAt

  // --- PRÉ: capturado na MESMA TRANSAÇÃO que grava appliedAt (§9.5) ---
  preSpendBase    Decimal @map("pre_spend_base")    @db.Decimal(14, 4)
  preRevenueBase  Decimal @map("pre_revenue_base")  @db.Decimal(14, 4)
  preConversions  Int     @map("pre_conversions")
  preAiScore      Float?  @map("pre_ai_score")

  // --- PÓS: nulos até a medição (§8.8, job recommendation-outcome-measure) ---
  postSpendBase   Decimal? @map("post_spend_base")   @db.Decimal(14, 4)
  postRevenueBase Decimal? @map("post_revenue_base") @db.Decimal(14, 4)
  postConversions Int?     @map("post_conversions")
  postAiScore     Float?   @map("post_ai_score")

  observedDelta     Decimal?          @map("observed_delta") @db.Decimal(14, 4)
  observedDeltaKind OutcomeDeltaKind? @map("observed_delta_kind")
  secondaryDeltas   Json?             @map("secondary_deltas")   // contexto, fora de P8
  verdict           OutcomeVerdict?
  confidence        Float?
  confounders       Json?

  engineVersion      String  @map("engine_version")
  /// A TERCEIRA coisa versionada do sistema, ao lado de algoVersion e detectorVersion.
  measurementVersion String? @map("measurement_version")

  recommendation Recommendation @relation(fields: [recommendationId], references: [id], onDelete: Cascade)

  @@index([organizationId, verdict, measuredAt])
  @@index([organizationId, status])
  @@index([lineageId])
  @@map("recommendation_outcomes")
}

enum OutcomeStatus    { PENDING_MEASUREMENT  MEASURED  ABANDONED }
enum OutcomeDeltaKind { SPEND_AVOIDED  REVENUE_DELTA  SCORE_DELTA  CPA_DELTA }
enum OutcomeVerdict   { IMPROVED  UNCHANGED  WORSENED  INCONCLUSIVE }
```

> **Os campos do pós são nullable por necessidade estrutural.** O pré tem que ser capturado no
> instante da aplicação — reconstruí-lo dias depois lê dado já re-declarado pela plataforma (§8.9) e
> contamina o dataset de P8 na origem, com o próprio fenômeno que o produto sabe existir. Se `post*`,
> `verdict` e `measuredAt` fossem `NOT NULL`, a linha não poderia existir antes da medição, e a
> captura no `apply` seria impossível de implementar.
>
> **`measurementVersion` não é conforto futuro.** §20-H3 condiciona a automação supervisionada a
> `CONFIRMED > 95%` **ao longo de 90 dias** — e em 90 dias a lógica de medição muda pelo menos uma
> vez. Sem a versão, outcomes medidos por regras diferentes entram no mesmo denominador, e o número
> que autoriza a Allva a agir sozinha sobre mídia paga vira média de duas medidas distintas. Como o
> pré e o pós ficam persistidos em valores brutos, outcomes são **re-mensuráveis offline** quando a
> lógica muda — mesmo padrão de versão em sombra de `algoVersion` (§12.5), e o relatório de replay de
> P8 passa a valer para as três versões.
>
> **Delta primário, não soma.** Uma recomendação com estimativa de `SAVINGS` e `EFFICIENCY_GAIN`
> produz **uma** medição — a de `Recommendation.primaryImpactType`. Os demais vão em
> `secondaryDeltas` como contexto e **não entram nas métricas de acurácia de P8**, senão a mesma
> recomendação é contada várias vezes.

| `RecommendationKind` | Delta primário |
|---|---|
| `PAUSE_UNDERPERFORMING_AD`, `CONSOLIDATE_OVERLAP`, `MITIGATE_NEGATIVE_FEEDBACK` | `SPEND_AVOIDED` |
| `REDUCE_BUDGET_HIGH_CPA`, `STABILIZE_LEARNING` | `CPA_DELTA` |
| `SCALE_WINNING_AD` | `REVENUE_DELTA` |
| `REFRESH_FATIGUED_CREATIVE`, `IMPROVE_WEAK_HOOK`, `REPLACE_CTA` | `SCORE_DELTA` |
| `EXPAND_AUDIENCE` (consultiva) | — não gera outcome |

```sql
-- "um plano por (ad, kind)" de §9.4, garantido pelo banco
CREATE UNIQUE INDEX recommendations_active_unique
  ON recommendations (ad_id, kind)
  WHERE status IN ('NEW','ACKNOWLEDGED','APPLYING');
```

## 4.6 Ações, execução e consentimento

```prisma
model AdAction {
  id               String  @id @default(uuid())
  adId             String  @map("ad_id")
  organizationId   String  @map("organization_id")
  recommendationId String? @map("recommendation_id")   // obrigatório se origin = RECOMMENDATION

  origin AdActionOrigin                                 // P3
  type   AdActionType
  level  ActionLevel @default(AD)

  /// Validado por schema por tipo. Valores monetários SEMPRE na moeda da conta (M3).
  /// Parâmetros originados de IA carregam aiAuthored, aiProvider, aiModel.
  parameters Json

  targetEntityType String @map("target_entity_type")    // AD | AD_SET | CAMPAIGN
  targetEntityId   String @map("target_entity_id")      // sustenta I2 generalizada

  previousState      Json?   @map("previous_state")
  reversible         Boolean @default(false)
  revertedByActionId String? @map("reverted_by_action_id")
  revertedBy         AdAction?  @relation("ActionRevert", fields: [revertedByActionId], references: [id])
  reverts            AdAction[] @relation("ActionRevert")

  scopeWarning String? @map("scope_warning")
  createdAt    DateTime @default(now()) @map("created_at")

  ad             Ad              @relation(fields: [adId], references: [id], onDelete: Cascade)
  recommendation Recommendation? @relation(fields: [recommendationId], references: [id])
  executions     ActionExecution[]

  @@index([adId, type])
  @@index([organizationId, origin])
  @@map("ad_actions")
}

enum AdActionOrigin { RECOMMENDATION  WASTE_RESOLUTION  USER_DIRECT  REVERT  AUTOMATION_RULE }

model ActionExecution {
  id             String @id @default(uuid())
  actionId       String @map("action_id")
  organizationId String @map("organization_id")

  targetEntityType String @map("target_entity_type")
  targetEntityId   String @map("target_entity_id")

  status         ExecutionStatus @default(QUEUED)
  attempt        Int             @default(1)

  /// Fornecida pelo cliente. Única POR ORGANIZAÇÃO: chave global faria duas organizações
  /// colidirem, e a segunda receberia o resultado da ação da primeira.
  idempotencyKey String @map("idempotency_key")
  /// Digest do pedido. Mesma chave com payload diferente é erro do cliente, não replay:
  /// devolver "o resultado original" seria devolver o resultado de OUTRA ação.
  requestDigest  String @map("request_digest")

  dryRun         Boolean @default(false) @map("dry_run")
  validationDepth String? @map("validation_depth")

  /// Relógio da EXECUÇÃO (enfileirar → plataforma responder), não da verificação.
  /// A escada de §8.5 tem o seu próprio, e mistura-los faria o reaper nunca disparar.
  expiresAt DateTime @map("expires_at")

  requestedByAccountId String @map("requested_by_account_id")
  correlationId   String? @map("correlation_id")
  requestPayload  Json?   @map("request_payload")
  responsePayload Json?   @map("response_payload")
  errorCode       String? @map("error_code")
  errorMessage    String? @map("error_message")

  /// Chave que liga o ad recriado à execução que o originou (requiresRecreate, DUPLICATE_AD)
  resultPlatformEntityId String? @map("result_platform_entity_id")

  startedAt           DateTime? @map("started_at")
  completedAt         DateTime? @map("completed_at")
  verificationAttempt Int       @default(0) @map("verification_attempt")
  verifiedAt          DateTime? @map("verified_at")
  verificationResult  VerificationResult? @map("verification_result")

  action             AdAction    @relation(fields: [actionId], references: [id], onDelete: Cascade)
  resolvedWasteItems WasteItem[] @relation("WasteResolution")

  @@unique([organizationId, idempotencyKey])
  @@index([actionId, status])
  @@index([organizationId, status])
  @@index([organizationId, startedAt])          // teto diário de escrita (§13.5)
  @@index([resultPlatformEntityId])
  @@map("action_executions")
}

enum ExecutionStatus { QUEUED  RUNNING  SUCCEEDED  FAILED  REJECTED_BY_PLATFORM  UNSUPPORTED  CANCELLED }
enum VerificationResult { CONFIRMED  DIVERGED  INCONCLUSIVE }

enum AdActionType {
  PAUSE_AD  ENABLE_AD  ARCHIVE_AD  DUPLICATE_AD
  REPLACE_CREATIVE  REPLACE_COPY  REPLACE_CTA
  PAUSE_AD_SET  ENABLE_AD_SET  ADJUST_AD_SET_BUDGET
  PAUSE_CAMPAIGN  ENABLE_CAMPAIGN  ADJUST_CAMPAIGN_BUDGET
}
```

```sql
-- I2 generalizada: no máximo uma escrita em voo por ALVO, não por anúncio
CREATE UNIQUE INDEX action_executions_inflight_unique
  ON action_executions (target_entity_type, target_entity_id)
  WHERE status IN ('QUEUED','RUNNING');
```

> **`expiresAt` exige quem o varra.** Expirar é ato, não propriedade: o campo existe para "liberar I2
> se travar", mas nada acontece se ninguém olhar. O job `action-execution-reaper` (§8.8) leva
> execuções vencidas a estado terminal, reverte `desiredStatus` e alerta. Sem ele, o alvo fica
> permanentemente sem aceitar ações, em silêncio — o oposto do que §8.5 promete.
>
> **`expiresAt` mede a execução, não a verificação.** A escada vai a T+2h e tem estado terminal
> próprio (`UNVERIFIED_WRITE`). Dimensionar `expiresAt` pela escada faria o reaper nunca disparar a
> tempo; o padrão é `appliedAt + 15 min`.

```prisma
/// P5 / §13.5 — o consentimento que §17 testa
model IntegrationWriteConsent {
  id             String @id @default(uuid())
  integrationId  String @map("integration_id")
  organizationId String @map("organization_id")

  grantedByAccountId String    @map("granted_by_account_id")
  grantedAt          DateTime  @default(now()) @map("granted_at")
  revokedAt          DateTime? @map("revoked_at")
  revokedByAccountId String?   @map("revoked_by_account_id")

  consentedActionTypes AdActionType[] @map("consented_action_types")
  ipAddress String? @map("ip_address")
  userAgent String? @map("user_agent")

  @@index([integrationId, revokedAt])
  @@map("integration_write_consents")
}
```

> `Organization.actionsEnabled` é **kill switch instantâneo por organização** (D4).
> `IntegrationWriteConsent` é **consentimento por integração**, concedido uma vez com registro de
> quem e quando. São dois controles distintos.

## 4.7 Sincronização e análise criativa

```prisma
model SyncOperation {
  id                String  @id @default(uuid())
  organizationId    String  @map("organization_id")
  integrationId     String  @map("integration_id")
  adAccountId       String? @map("ad_account_id")
  adId              String? @map("ad_id")
  actionExecutionId String? @map("action_execution_id")   // fecha a trilha ação → escrita

  direction SyncDirection
  kind      SyncKind
  trigger   SyncTrigger
  status    SyncOperationStatus @default(QUEUED)

  windowStart           DateTime? @map("window_start")
  windowEnd             DateTime? @map("window_end")
  restatementWindowDays Int?      @map("restatement_window_days")

  entitiesRead    Int     @default(0) @map("entities_read")
  entitiesWritten Int     @default(0) @map("entities_written")
  driftsDetected  Int     @default(0) @map("drifts_detected")
  wasComplete     Boolean @default(false) @map("was_complete")   // habilita arquivamento
  checkpoints     Json?                                           // retomada
  stepResults     Json?   @map("step_results")

  errorCode    String?   @map("error_code")
  errorMessage String?   @map("error_message")
  startedAt    DateTime? @map("started_at")
  finishedAt   DateTime? @map("finished_at")

  ad Ad? @relation(fields: [adId], references: [id])

  @@index([integrationId, startedAt])
  @@index([adId, startedAt])
  @@index([organizationId, status])
  @@map("sync_operations")
}

enum SyncDirection { INBOUND  OUTBOUND }
enum SyncKind { FULL_ACCOUNT  STRUCTURE_ONLY  METRICS_ONLY  AD_REFRESH  ACTION_WRITE  RECONCILIATION  REBIND }
enum SyncTrigger { SCHEDULE  MANUAL  WRITE_THROUGH  RECONCILE  BACKFILL  REBIND }
enum SyncOperationStatus { QUEUED  RUNNING  SUCCEEDED  PARTIAL  FAILED }

/// Ad cuja campanha/conjunto não pôde ser resolvido. Nunca descartado em silêncio —
/// e nunca preso: todo ingest tenta re-resolver a quarentena da conta antes de processar.
model SyncQuarantine {
  id             String @id @default(uuid())
  organizationId String @map("organization_id")
  adAccountId    String @map("ad_account_id")
  externalAdId   String @map("external_ad_id")
  reason         String
  attempts       Int    @default(1)
  firstSeenAt    DateTime @default(now()) @map("first_seen_at")
  lastSeenAt     DateTime @default(now()) @map("last_seen_at")
  payload        Json?

  resolvedAt     DateTime?               @map("resolved_at")
  resolvedReason QuarantineResolution?   @map("resolved_reason")

  adAccount AdAccount @relation(fields: [adAccountId], references: [id])
  @@map("sync_quarantine")
}

enum QuarantineResolution { PARENT_APPEARED  ABANDONED  AD_DISAPPEARED }

model CreativeAnalysis {
  id               String  @id @default(uuid())
  creativeId       String  @map("creative_id")
  adId             String? @map("ad_id")            // null só para uploads pré-veiculação
  creativeUploadId String? @map("creative_upload_id")
  organizationId   String  @map("organization_id")
  accountId        String  @map("account_id")

  version Int            @default(1)
  status  AnalysisStatus @default(PENDING)
  trigger AnalysisTrigger

  adScoreId     String? @map("ad_score_id")
  metricsDigest String? @map("metrics_digest")   // inclui Creative.contentHash

  diagnostics       Json?
  hookSuggestions   Json?  @map("hook_suggestions")
  bodySuggestions   Json?  @map("body_suggestions")
  ctaSuggestions    Json?  @map("cta_suggestions")
  formatSuggestions Json?  @map("format_suggestions")
  candidates        Json?  // criativos substitutos ranqueados (§11.4)

  engineVersion String  @map("engine_version")
  enrichedByAI  Boolean @default(false) @map("enriched_by_ai")
  aiAuthored    Boolean @default(false) @map("ai_authored")
  aiProvider    String? @map("ai_provider")
  aiModel       String? @map("ai_model")

  errorMessage String?   @map("error_message")
  startedAt    DateTime? @map("started_at")
  completedAt  DateTime? @map("completed_at")

  creative Creative @relation(fields: [creativeId], references: [id])
  ad       Ad?      @relation(fields: [adId], references: [id], onDelete: Cascade)

  @@index([organizationId, status])
  @@index([adId, version(sort: Desc)])
  @@map("creative_analyses")
}
```

```sql
CREATE UNIQUE INDEX creative_analyses_version_unique
  ON creative_analyses (creative_id, ad_id, version) WHERE ad_id IS NOT NULL;

-- Mesma correção do Apêndice A nº 6, aplicada à quarentena: uma unique total impediria
-- o mesmo ad de voltar à quarentena depois de resolvido uma vez.
CREATE UNIQUE INDEX sync_quarantine_open_unique
  ON sync_quarantine (ad_account_id, external_ad_id) WHERE resolved_at IS NULL;
```

```prisma
/// D7.1 — a tabela permanece; a superfície de upload fica FORA do escopo da v2.0 (§11.6).
model CreativeUpload {
  id             String @id @default(uuid())
  accountId      String @map("account_id")
  organizationId String @map("organization_id")

  fileName     String  @map("file_name")
  mimeType     String  @map("mime_type")
  sizeBytes    Int     @map("size_bytes")
  storageKey   String  @map("storage_key")
  thumbnailUrl String? @map("thumbnail_url")
  durationMs   Int?    @map("duration_ms")
  width        Int?
  height       Int?
  contentHash  String? @map("content_hash")
  createdAt    DateTime @default(now()) @map("created_at")

  analyses CreativeAnalysis[]

  @@index([organizationId, createdAt])
  @@index([contentHash])
  @@map("creative_uploads")
}

/// Configuração versionada de limiares. Calibração de P8 opera aqui, não no código.
model DetectorProfile {
  id             String    @id @default(uuid())
  version        String
  organizationId String?   @map("organization_id")   // null = padrão global
  thresholds     Json                                 // por FindingType
  provenance     String                               // origem de cada valor
  effectiveFrom  DateTime  @map("effective_from")

  @@unique([version, organizationId])
  @@map("detector_profiles")
}

/// FKs TIPADAS — nunca subject_type/subject_id.
/// Sem lista explícita de colunas, os campos que o v1 JÁ TINHA (modelVersion,
/// promptVersion, durationMs) se perdem na reimplementação. Reticências em spec
/// são exatamente como campo desaparece.
model AIDecisionLog {
  id             String  @id @default(uuid())
  organizationId String  @map("organization_id")
  adId             String? @map("ad_id")
  creativeUploadId String? @map("creative_upload_id")
  recommendationId String? @map("recommendation_id")

  taskType String @map("task_type")             // casa com activePromptVersions (§4.1)
  provider String                                // SEPARADO de model: o roteamento é multi-provider
  model    String
  promptVersion String @map("prompt_version")

  outcome      AiCallOutcome
  /// O roteamento já faz cooldown e fallback. Sem registrar quem DE FATO atendeu,
  /// todo benchmark de custo-por-modelo erra justamente nas chamadas que caíram
  /// para o secundário — que são as interessantes.
  fallbackUsed Boolean @default(false) @map("fallback_used")

  inputTokens  Int?     @map("input_tokens")
  outputTokens Int?     @map("output_tokens")
  latencyMs    Int?     @map("latency_ms")
  costBase     Decimal? @map("cost_base") @db.Decimal(14, 6)

  /// Torna P9 auditável a partir do próprio log: "houve chamada sem mudança de
  /// digest?" vira query, não teste de confiança.
  inputDigest String? @map("input_digest")

  /// Conteúdo de marca do cliente e volume alto: hash sempre, texto atrás de flag
  /// com retenção curta.
  promptHash   String  @map("prompt_hash")
  responseText String? @map("response_text")
  errorPayload Json?   @map("error_payload")

  correlationId String? @map("correlation_id")
  createdAt     DateTime @default(now()) @map("created_at")

  @@index([organizationId, createdAt])
  @@index([organizationId, provider, model, createdAt])
  @@index([adId])
  @@map("ai_decision_logs")
}

/// Chamada NÃO feita por teto (§C9) ou por digest inalterado (P9) é informação de
/// produto: é a economia funcionando. Sem registro, é indistinguível de bug.
enum AiCallOutcome { SUCCEEDED  FAILED  SKIPPED_BUDGET  SKIPPED_DIGEST }
```

```sql
ALTER TABLE ai_decision_logs ADD CONSTRAINT ai_decision_logs_one_subject
  CHECK (num_nonnulls(ad_id, creative_upload_id, recommendation_id) = 1);
```

```prisma
/// Substitui referenceType/referenceId por FKs tipadas. Preserva o dedupe do v1
/// (fingerprint, occurrences, lifecycle), que é ativo maduro — corrige só o que erra.
model Alert {
  id             String @id @default(uuid())
  organizationId String @map("organization_id")
  type     AlertType
  severity AlertSeverity @default(INFO)
  title    String
  message  String

  // --- SEIS sujeitos, não cinco ---
  adId              String? @map("ad_id")
  adAccountId       String? @map("ad_account_id")
  wasteItemId       String? @map("waste_item_id")
  recommendationId  String? @map("recommendation_id")
  actionExecutionId String? @map("action_execution_id")
  integrationId     String? @map("integration_id")

  // --- dedupe: timestamps de DOMÍNIO, não técnicos ---
  fingerprint     String
  occurrences     Int      @default(1)
  firstOccurredAt DateTime @default(now()) @map("first_occurred_at")
  lastOccurredAt  DateTime @default(now()) @map("last_occurred_at")

  readAt      DateTime? @map("read_at")
  dismissedAt DateTime? @map("dismissed_at")
  resolvedAt  DateTime? @map("resolved_at")
  notifiedAt  DateTime? @map("notified_at")

  correlationId String?  @map("correlation_id")
  metadata      Json?
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@index([organizationId, type, resolvedAt])
  @@index([organizationId, readAt])
  @@map("alerts")
}
```

```sql
ALTER TABLE alerts ADD CONSTRAINT alerts_one_subject
  CHECK (num_nonnulls(ad_id, ad_account_id, waste_item_id,
                      recommendation_id, action_execution_id, integration_id) = 1);

-- O v1 declara intenção de índice parcial num comentário. Intenção não impede duplicata:
-- é o mesmo achado do Apêndice A nº 6. Aqui vira restrição de verdade.
CREATE UNIQUE INDEX alerts_open_unique
  ON alerts (fingerprint) WHERE resolved_at IS NULL;
```

Novos tipos: `AD_SCORE_DROPPED`, `AD_DRIFT_DETECTED`, `ACTION_FAILED`, `ACTION_VERIFIED`,
`INTEGRATION_DISCONNECTED`, `AD_ARCHIVE_SUPPRESSED`, `SYNC_QUARANTINE`, `UNVERIFIED_WRITE`,
`DENORMALIZATION_DRIFT`, `AI_BUDGET_EXCEEDED`, `PARTITION_MARGIN_LOW`.

> Associação polimórfica por string é a causa raiz do alerta órfão do v1 — o worker de waste passava
> `referenceType: 'waste_item'` sem nunca passar `referenceId`. O conjunto de assuntos é fechado e
> pequeno; não há necessidade de polimorfismo.
>
> **São seis sujeitos porque dois tipos são sobre a CONTA, não sobre um anúncio.** Em
> `SYNC_QUARANTINE` o anúncio sequer existe no domínio — é essa a razão do alerta. E
> `AD_ARCHIVE_SUPPRESSED` reporta que a guarda de §8.2 impediu o arquivamento de uma conta inteira.
> Sem `adAccountId`, esses dois nasceriam sem FK — exatamente o órfão que o modelo existe para
> impedir.
>
> **`updatedAt` não pode servir de última ocorrência.** É `@updatedAt`: bumpa em qualquer escrita.
> Marcar como lido, dispensar ou registrar `notifiedAt` reescreveria `updatedAt`, e o produto passaria
> a reportar "última ocorrência: agora" para uma condição que não recorre há uma semana — um
> timestamp técnico lido como timestamp de domínio. Só o caminho de dedupe escreve `lastOccurredAt`.

```prisma
/// Idempotência de janela (§8.8) e coordenação distribuída dos jobs.
/// Sem esta tabela, "o cron verifica a chave de idempotência da janela" não tem onde verificar:
/// cada janela roda duas vezes, dobrando custo de LLM (P9) e inflando occurrences, que é sinal de P8.
model JobRun {
  id        String @id @default(uuid())
  jobName   String @map("job_name")
  scopeType JobScopeType @map("scope_type")
  scopeId   String @map("scope_id")
  windowKey String @map("window_key")       // "2026-08-01T14" | "2026-08-01"

  status     JobRunStatus @default(RUNNING)
  skipReason String?      @map("skip_reason")
  attempt    Int          @default(1)       // token de cerca (fencing token) — ver abaixo

  startedAt       DateTime  @default(now()) @map("started_at")
  leaseExpiresAt  DateTime  @map("lease_expires_at")
  finishedAt      DateTime? @map("finished_at")
  durationMs      Int?      @map("duration_ms")

  processedItems  Int @default(0) @map("processed_items")
  successfulItems Int @default(0) @map("successful_items")
  failedItems     Int @default(0) @map("failed_items")

  correlationId String? @map("correlation_id")
  result        Json?
  errorMessage  String? @map("error_message")

  @@unique([jobName, scopeType, scopeId, windowKey])
  @@index([jobName, startedAt])
  @@index([status, leaseExpiresAt])
  @@map("job_runs")
}

enum JobRunStatus  { RUNNING  SUCCEEDED  FAILED  SKIPPED }
enum JobScopeType  { AD_ACCOUNT  ORGANIZATION  INTEGRATION  GLOBAL }
```

`skipReason` tem vocabulário fechado — `SKIPPED` sem razão é tão opaco quanto não ter status:
`NO_NEW_DATA` · `EMPTY_WINDOW` · `INTEGRATION_DISCONNECTED` · `ACCOUNT_UNREACHABLE` ·
`FEATURE_DISABLED` · `UPSTREAM_NOT_READY` · `CURRENCY_RECOMPUTING` · `BUDGET_EXCEEDED`.

**A unique é o mecanismo — mas `DO NOTHING` não serve.** Uma linha `SKIPPED` ocupa o slot
`(job, escopo, janela)`. Se o motivo desaparecer dentro da mesma janela — a integração reconecta às
14h15, o upstream termina, a flag é ligada — a próxima tentativa bateria no conflito, não faria nada,
e **a janela nunca rodaria**. O status que existe para melhorar observabilidade criaria um buraco
silencioso de processamento. A aquisição é um **takeover condicional**:

```sql
INSERT INTO job_runs (job_name, scope_type, scope_id, window_key,
                      status, started_at, lease_expires_at, correlation_id)
VALUES ($1,$2,$3,$4,'RUNNING', now(), now() + $lease, $5)
ON CONFLICT (job_name, scope_type, scope_id, window_key) DO UPDATE
   SET status='RUNNING', started_at=now(), attempt=job_runs.attempt+1,
       lease_expires_at=now() + $lease, skip_reason=NULL, correlation_id=$5
 WHERE job_runs.status IN ('SKIPPED','FAILED')
    OR (job_runs.status='RUNNING' AND job_runs.lease_expires_at < now())
RETURNING id, attempt;
```

Nenhuma linha retornada ⇒ outro worker é dono (lease vivo) ou a janela já teve `SUCCEEDED`. Isso
preserva a idempotência exatamente onde ela importa — **`SUCCEEDED` nunca reexecuta** — e libera o
que é legitimamente retentável.

**Posse verificada em toda escrita, não só na renovação.** Renovar é o menos perigoso que um worker
zumbi faz; **concluir** é o destrutivo. Um worker congelado às 14h03 que volta às 14h22, depois de
outro ter feito takeover, marcaria a janela como `SUCCEEDED` com contadores zerados — e `SUCCEEDED`
nunca reexecuta, então o buraco é permanente. `attempt` é monotônico por linha e serve de token de
cerca:

```sql
-- heartbeat, a cada lease/3
UPDATE job_runs SET lease_expires_at = now() + $lease
 WHERE id = $1 AND attempt = $2 AND status = 'RUNNING';

-- conclusão — MESMA guarda, e é esta que importa
UPDATE job_runs
   SET status = $3, finished_at = now(), duration_ms = $4,
       processed_items = $5, successful_items = $6, failed_items = $7, result = $8
 WHERE id = $1 AND attempt = $2 AND status = 'RUNNING';
```

Zero linhas afetadas ⇒ **o worker perdeu a posse e aborta imediatamente**: não finaliza, não escreve
resultado, não emite evento de conclusão. E consulta a posse antes de todo efeito colateral não
idempotente — escrita de domínio é upsert por chave, mas **chamada de LLM é dinheiro** e dobrá-la
viola P9.

| Fronteira | Regra |
|---|---|
| `JobRun` × `SyncOperation` | `JobRun` é **uma por (job, escopo, janela)** e conta a unidade de trabalho do job (contas ingeridas, ads pontuados). `SyncOperation` é **uma por execução de sync** — várias por `JobRun` — e conta entidades lidas/escritas **na plataforma**. Dashboard operacional lê `JobRun`; auditoria de sync lê `SyncOperation`. **Nunca somar os dois.** |
| `JobRun` × `ActionExecution` | Execução de ação em plataforma **nunca** roda sob lease de `JobRun`. A exclusão mútua da escrita é I2 + `expiresAt`, outro mecanismo com outro relógio. Dois donos para a mesma exclusão mútua é como ela deixa de existir. |

## 4.8 Mapa de relacionamentos

```text
Organization ─┬─ OrganizationAdsSettings (1:1 — janela, versões ativas, tetos)
              ├─ AdAccount ─┬─ Integration (credencial corrente, substituível)
              │             │      └─ IntegrationWriteConsent
              │             ├─ Campaign ── AdSet ──┐
              │             ├─ Creative ────────┐  │
              │             ├─ SyncQuarantine   │  │
              │             └─ Ad ◄─────────────┴──┘
              │                  └─ lineageId ──► (série que atravessa recriações)
              ├─ FxRate · CurrencyMigration · DetectorProfile · JobRun
              └─ CreativeUpload ──► CreativeAnalysis (pré-veiculação, adId = null)

Ad ─┬─ AdMetricSnapshot   (1:N, cascade)
    ├─ AdScore            (1:N, cascade; carrega creativeId vigente)
    ├─ WasteItem          (1:N, cascade) ◄──N:N──► Recommendation
    ├─ Recommendation     (1:N, cascade) ──► AdAction (1:N) ──► ActionExecution (1:N)
    │                             └──► RecommendationOutcome (0:1)   ← LEARN
    ├─ CreativeAnalysis   (1:N, cascade)
    ├─ AIDecisionLog · Alert (0:N)
    └─ SyncOperation      (0:N) ◄── actionExecutionId (trilha de escrita)

ActionExecution ──resultPlatformEntityId──► Ad derivado (originActionExecutionId)
```

---

# 5. Arquitetura dos Módulos

## 5.1 Camadas

```text
domain/          entidades, value objects, enums, ports (abstract classes), serviços puros
application/     use cases, DTOs, application services (orquestração), políticas
infrastructure/  controllers HTTP, repositórios Prisma, adapters, workers Bull, schedulers
```

## 5.2 Mapa de módulos

```text
src/modules/
├── ads/                        ★ o agregado e seus read models
├── ad-scoring/                 ★ extraído de creative-lab
├── waste/                      ↻ detecção por ad
├── recommendations/            ↻ recomendação → ações
├── platform-actions/           ★ o caminho de escrita
├── sync/                       ★ extraído de integrations
├── platform-clients/           ★ transporte compartilhado por plataforma
│   ├── http client + refresh de token por integração
│   ├── token bucket / rate limit por integração
│   └── classificador de erro + backoff com jitter
├── currency/                   ★ dono único de toda lógica monetária
│   ├── domain/                 CurrencyNormalizationService (C1–C7)
│   ├── application/            CurrencyMigrationService
│   └── infrastructure/         FxRatesRepository — único acesso a fx_rates
├── creative-lab/               ↻ análise por par (Creative, Ad)
├── integrations/               ↻ conexão/OAuth/credenciais + gateway de leitura
├── analytics/                  ↻ rollups derivados de ad
├── alerts/                     ↻ consumidor de evento puro, com FKs tipadas
├── audit/                      ↻ vocabulário estendido
├── reports/                    ↻ templates ad-first
├── dev-tools/                  ↻ seed de ads, scores, waste, oportunidades, linhagem
├── ai/                         ↻ contratos por assunto, não por campanha
└── campaigns/                  ✖ REMOVIDO (pipeline local) — D1

Intocados: accounts · auth · billing · organizations · security · plans · subscriptions ·
invoices · sales-leads · contacts · provisioning · notifications · preferences · upload · health
```

**Por que `platform-clients` existe.** ISP separa os gateways de leitura e escrita, e isso está
certo — mas ISP se aplica ao **contrato**, não ao **transporte**. Leitura e escrita da mesma
plataforma compartilham credencial, refresh de token, orçamento de chamadas e semântica de erro.
Mantê-los em módulos que não podem se importar torna o token bucket de R4 impossível de implementar.

**Por que `currency` existe.** Sem um dono único, as regras M1–M4 viram disciplina que cada módulo
cumpre por conta própria, e a primeira violação é silenciosa.

## 5.3 Grafo e regras de dependência

```text
                        ┌──────────────┐
                        │     ads      │  agregado + read models
                        └──────┬───────┘
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
   ad-scoring                sync            platform-clients ◄── integrations
         │              (estado observado)       (transporte)          │
    ┌────┴─────┐                                                       │
    ▼          ▼                                                       │
  waste   creative-lab                                                 │
    └────┬─────┘                                                       │
         ▼                                                             │
   recommendations                                                     │
         │                                                             │
         ▼                                                             │
  platform-actions ─────────────────────────────────────────────────────┘
  (estado desejado)

  currency  ──► dependência de qualquer módulo; não depende de nenhum
  alerts · audit ──► consumidores de evento puros; zero dependência de entrada
```

1. **`ads` é a base.** Não depende de nenhum módulo de inteligência. Expõe read models; não os
   calcula a partir de outros módulos.
2. **`ad-scoring` é upstream de `waste` e `creative-lab`.** Os dois consomem o **port de leitura**
   `AdScoreReader`; nunca importam serviços de **cálculo** de `ad-scoring`. A recíproca é proibida.

   ```typescript
   // ad-scoring/domain/ports/ad-score-reader.port.ts
   export abstract class AdScoreReader {
     abstract currentByAdIds(orgId: string, adIds: string[]): Promise<Map<string, AdScoreView>>;
     abstract seriesByLineage(orgId: string, lineageId: string, range: DateRange): Promise<AdScoreView[]>;
   }
   ```

   > Redação anterior — "`ads` não calcula read models de outros" **e** "`waste` não importa nada de
   > `ad-scoring`" — não deixava ninguém publicar `AdScoreView`. Um port de leitura preserva a
   > intenção (não acoplar ao cálculo) sem a impossibilidade lógica.
3. **`waste` e `creative-lab` não se conhecem entre si.**
4. **`recommendations` é o único que compõe** waste + score + análise criativa num plano.
5. **`platform-actions` é downstream de `recommendations`.** É o único que escreve na plataforma;
   nenhum outro importa `AdActionGateway`.
6. **`sync` não conhece inteligência.** Emite eventos; quem escuta decide o que recomputar.
7. **`alerts` e `audit` são consumidores de evento puros.** Nenhum módulo os injeta diretamente —
   é a ausência desta regra que produzia o alerta órfão do v1.
8. **`platform-clients` é dependência de `integrations` e `platform-actions` — e não importa
   nenhum dos dois.** O transporte precisa de credencial e de refresh de token, mas as credenciais
   pertencem a `integrations`, que depende de `platform-clients`. Sem inversão, o módulo nasce com
   dependência circular e o token bucket de R4 volta a ser impossível — que é a razão de ele existir.

   ```typescript
   // platform-clients/domain/ports/platform-credential.provider.ts
   export abstract class PlatformCredentialProvider {
     abstract resolve(adAccountId: string): Promise<PlatformCredential>;
     abstract onRefreshed(integrationId: string, tokens: RefreshedTokens): Promise<void>;
   }
   ```

   `integrations` implementa e registra. O refresh acontece **dentro** de `platform-clients` — é
   transporte — e devolve os tokens por `onRefreshed`, que `integrations` persiste cifrado com o
   `TokenCipherService` existente.
9. **`currency`** pode ser dependência de qualquer módulo e não depende de nenhum. Nenhum outro
   módulo implementa conversão, derivação por pivô, arredondamento ou acesso a `fx_rates`.
10. **O caminho HTTP não determina o módulo dono.** `ads` é dono apenas das rotas de **leitura** do
    agregado. Rotas que escrevem ou disparam trabalho vivem em quem as executa, mesmo compartilhando
    o prefixo `/ads`:

    | Prefixo | Módulo dono |
    |---|---|
    | `GET /ads`, `/ads/{id}`, `/ads/{id}/{scores,metrics,waste,recommendations,history,analysis}` | `ads` |
    | `POST /ads/{id}/actions*`, `/ads/actions/batch`, `/ads/{id}/apply-recommendation`, `/ads/{id}/status-change` | `platform-actions` |
    | `POST /ads/{id}/analyze` | `creative-lab` |
    | `POST /ads/{id}/sync`, `/ads/sync-batch` | `sync` |
    | `POST /ads/{id}/resolve` | `waste` |

    Sem a regra, o prefixo compartilhado convida `ads` a importar `platform-actions` e a base do
    grafo passa a depender da ponta. Verificado por `route-ownership.spec.ts`.

## 5.4 Propriedade de escrita e consistência

Cinco módulos escrevem em colunas de `ads`. Cada grupo tem **um dono**; os demais leem.

| Grupo de campos | Dono | Gatilho | Frescor | Exposto como |
|---|---|---|---|---|
| `observedStatus`, `observedRawStatus`, `observedAsOf`, `lastStructureSyncAt`, `lastMetricsSyncAt`, `archivedAt` | `sync` | ingest / refresh | ≤ 24h | `syncState` |
| `dataMaturity` | `sync` | ingest | ≤ 24h | `meta.dataMaturity` |
| `desiredStatus`, `desiredStatusSetAt` | `platform-actions` | execução de ação | imediato | `pendingAction` |
| `syncState`, `syncStateAt`, `driftDetails` | `sync` (inbound) · `platform-actions` (→ `PENDING_WRITE`) | máquina de estados | imediato | `syncState` |
| `currentScoreId`, `currentAiScore`, `currentScoreConfidence`, `currentScoreCoverage`, `scoreDelta7d`, `scoreAsOf` | `ad-scoring` | worker diário | diário | `score.asOf` |
| `openWaste*`, `avoidableDailyAmountBase`, `wasteAsOf` | `waste` | worker diário | diário | `waste.asOf` |
| `lineageId`, `originAdId`, `originActionExecutionId` | `sync` (descoberta) · `platform-actions` (derivação) | criação | imediato | `lineage` |

> **`dataMaturity` é do `sync`, não do `ad-scoring`.** Ela deriva da janela de atribuição da conta
> (`AdAccount.attributionWindowDays`) contra a data do dado — é propriedade da observação, não do
> cálculo. Quem a escrevesse a partir do scoring inverteria a dependência: a detecção precisa dela
> **antes** de decidir se pode rodar (§8.9).

1. **Campo tem dono único.** Nenhum outro módulo escreve.
2. **Denormalização de leitura nunca é fonte de verdade.** Divergência entre `openWasteAmount` e a
   agregação de `waste_items` é bug do worker. Job diário de reconciliação compara e alerta.
3. **Todo número derivado exposto na API carrega `asOf`** (P7).

## 5.5 Leitura e escrita

| Lado | Padrão | Onde |
|---|---|---|
| **Write** | Use case + repositório sobre o agregado | ações, resoluções, sync |
| **Read** | Read models dedicados, query direta, sem hidratar entidades | `AdListItemView`, `AdDetailView`, rollups |

CQRS completo (bus, handlers, event store) é overhead injustificado. Eventos de domínio são
in-process (`@nestjs/event-emitter`), com payloads serializáveis.

**O read model da tela principal é servido por denormalização de valor.** `GET /ads` filtra por
`scoreBelow` e ordena por `scoreDelta` dentro de p95 < 400 ms com 10k anúncios — `currentScoreId`
seria um ponteiro, exigindo join para filtrar e duas leituras da série para ordenar. Os valores
(`currentAiScore`, `scoreDelta7d`, `avoidableDailyAmountBase`) ficam denormalizados em `ads`, sob
propriedade dos respectivos donos.

## 5.6 Eventos de domínio

**Regra normativa.** Todo evento carrega os identificadores que seus consumidores precisam para agir
sem consultar outra fonte — o payload é contrato, não conveniência. Todo passo dirigido por evento é
**idempotente** e **re-derivável** pelo job agendado; o cron é rede de segurança permanente.

### 5.6.1 Envelope

```typescript
export type DomainEvent<K extends keyof DomainEventMap> = {
  eventId: string;              // identidade própria — é o alvo do causationId do próximo
  name: K;                      // estável para sempre; a versão NÃO entra no nome
  eventVersion: number;
  occurredAt: string;
  organizationId: string;
  correlationId: string;        // constante na cadeia inteira
  causationId: string | null;   // eventId do imediatamente anterior; null na origem
  payload: DomainEventMap[K];
};

export abstract class DomainEventBus {
  abstract emitFrom<K extends keyof DomainEventMap>(
    ctx: JobContext, name: K, payload: DomainEventMap[K],
  ): void;
}
```

**A versão vive na envelope, nunca no nome.** `ad.scored.v2` fragmentaria as assinaturas: um
consumidor que só entende a v1 pararia de receber tudo, em vez de receber e ignorar o que não
conhece. Regra de bump: campo novo opcional **não** bumpa — consumidores toleram campo desconhecido;
remoção de campo, mudança de tipo ou de semântica **bumpa**. Versões coexistem por evento
(`ad.scored` na v1 e `recommendation.generated` na v2, simultaneamente).

**`correlationId` e `causationId` respondem perguntas diferentes.**

| | Nasce | Muda | Responde |
|---|---|---|---|
| `correlationId` | na origem — tick do cron, requisição HTTP, gatilho manual | nunca | *"tudo que aconteceu por causa daquele ingest das 14h"* |
| `causationId` | a cada salto | sempre | *"o que exatamente gerou este evento"* |

Com os dois, `waste.detected` responde tanto de qual ciclo veio quanto qual `ad.scored`
especificamente o disparou: o **grafo** é reconstruível, não só a lista. `causationId` exige
`eventId` — sem identidade de evento, causalidade não é representável.

### 5.6.2 A fronteira da fila

`@nestjs/event-emitter` é **in-process e síncrono**: um handler lento bloqueia o emissor e um crash
perde o evento. Isso é aceitável porque todo passo é re-derivável pelo cron — **desde que** a regra
abaixo seja respeitada.

> **Handler que faz I/O pesado apenas enfileira um job Bull. Nunca executa inline.** Sem isso, o
> `sync` trava atrás do scoring, e um lote de ingest passa a ter a latência da cadeia inteira.

Como a cadeia atravessa a fila em **todos os saltos que importam**, a correlação morre ali a não ser
que viaje dentro do payload do job:

```typescript
export type JobContext = { correlationId: string; causationId: string | null };
// todo payload de job Bull carrega JobContext; emitFrom(ctx, …) preenche a envelope
```

Sem isso, a rastreabilidade funciona exatamente nos saltos triviais e falha nos sete que se quer
auditar.

**Onde a correlação aterrissa.** Rastrear eventos sem rastrear os registros que eles produziram
resolve metade do problema. `correlationId` é coluna nullable em `JobRun`, `SyncOperation`,
`ActionExecution`, `AIDecisionLog`, `Alert`, `CurrencyMigration` e `AuditLog` — as tabelas que já são
forenses por natureza. "O que este ciclo de ingest causou" vira uma query, em vez de correlação
manual por timestamp. Um interceptor gera o id por requisição, honrando `X-Correlation-Id` de
entrada quando houver.

| Evento | Emissor | Payload mínimo | Consumidores |
|---|---|---|---|
| `ad.discovered` | sync | `adId, lineageId, adAccountId, organizationId` | ad-scoring |
| `ad.derived` | sync | `adId, lineageId, originAdId, originActionExecutionId` | ad-scoring, recommendations |
| `ad.metrics.updated` | sync | `adId, organizationId, dateRange, inputDigest` | ad-scoring, waste |
| `ad.status.changed` | sync | `adId, from, to, source` (`ALLVA_ACTION`\|`EXTERNAL`\|`PLATFORM_RULE`) | waste, alerts |
| `ad.archived` | sync | `adId, lineageId, lastObservedAt` | waste (→ STALE), recommendations, alerts |
| `ad.scored` | ad-scoring | `adId, adScoreId, aiScore, delta7d, algoVersion` | waste, creative-lab, alerts |
| `ad.drifted` | sync | `adId, expected, observed, driftCause` | alerts, audit |
| `waste.detected` | waste | `adId, wasteItemId, type, kind, amounts, currency, priority` | recommendations, alerts |
| `waste.resolved` | waste | `adId, wasteItemId, resolutionKind` | recommendations, alerts |
| `recommendation.generated` | recommendations | `adId, recommendationId, kind, actionIds[]` | alerts |
| `recommendation.applied` | recommendations | `adId, recommendationId, executionIds[]` | sync (agenda verificação) |
| `recommendation.outcome.measured` | recommendations | `recommendationId, lineageId, observedDelta, verdict` | alerts, calibração |
| `action.executed` | platform-actions | `adId, actionId, executionId, origin, status, resultPlatformEntityId?` | audit, sync, waste |
| `action.reverted` | platform-actions | `adId, actionId, revertedByActionId` | audit, alerts |
| `action.verified` | sync | `adId, executionId, verificationResult` | recommendations, waste |
| `calibration.published` | ad-scoring / waste | `algoVersion \| detectorVersion, organizationId, scope` | audit, alerts |
| `integration.disconnected` | integrations | `integrationId, adAccountIds[]` | sync (→ UNREACHABLE), alerts |
| `integration.rebound` | integrations | `integrationId anterior e novo, religados[], inacessíveis[]` | sync, audit, alerts |
| `ad_account.discovered` | integrations | `adAccountId, platform` | sync |
| `sync.quarantined` | sync | `adAccountId, externalAdId, reason` | alerts |
| `organization.base_currency.change_requested` | currency | `organizationId, from, to, migrationId` | waste/ad-scoring/recommendations (pausa), audit |
| `organization.base_currency.recomputed` | currency | `organizationId, baseCurrency, migrationId, rowCounts` | workers (retomada), audit |

---

# 6. Vereditos sobre os módulos existentes

| Módulo | Veredito | Sprint |
|---|---|---|
| `campaigns` (local) | ✖ Removido — viola P1 e P2 na raiz; zero usuários (D1) | S1 |
| `ads` | ★ Criar | S2 |
| `ad-scoring` | ★ Criar (extrair de creative-lab, calculadoras intactas) | S4 |
| `sync` | ★ Criar (extrair de integrations) | S3 |
| `platform-actions` | ★ Criar | S7 |
| `platform-clients` | ★ Criar (extrair transporte dos providers) | S1 |
| `currency` | ★ Criar | S1 |
| `waste` | ↻ Redesenhar — detecção por ad, duas famílias, duas grandezas | S5 |
| `recommendations` | ↻ Redesenhar — ações executáveis, conflito, supressões | S6 |
| `creative-lab` | ↻ Redesenhar — par (Creative, Ad); scoring sai daqui | S4 |
| `integrations` | ↻ Reduzir — conexão/OAuth/credenciais; sync e transporte saem | S1/S3 |
| `analytics` | ↻ Ajustar — remove `campaignLevelOnly`; rollups por `open_waste` | S5 |
| `alerts` | ↻ Ajustar — consumidor de evento puro, FKs tipadas | S3/S5 |
| `audit` | ↻ Estender — vocabulário de ações de mídia | S7 |
| `ai` | ↻ Retipar — `AdAnalysis*`; roteamento multi-provider preservado | S4 |
| `reports` | ↻ Ajustar — templates ad-first | S9 |
| `dev-tools` | ↻ Ajustar — seed novo | S1 |

**Ativos preservados sem alteração:** calculadoras de score puras (mudam de endereço, não de lógica);
roteamento multi-provider de IA (classificação de erro, cooldown, backoff — maduro e agnóstico);
camadas Clean Architecture com ports como `abstract class`; modelo de alertas (fingerprint, dedupe,
lifecycle); infra de auditoria; RBAC e multi-tenancy; segurança de credenciais (AES-GCM, lockout,
replay); infra de filas Bull; e o seam determinístico → IA, que é o modelo a replicar.

---

# 7. Endpoints e Contratos

## 7.0 Convenções transversais

### 7.0.1 Envelope de sucesso

```jsonc
{
  "data": { /* … */ },
  "meta": {
    "asOf": "2026-07-30T03:12:00Z",
    "dataMaturity": "MATURE",              // IMMATURE | SETTLING | MATURE
    "evidenceSufficiency": "SUFFICIENT",   // SUFFICIENT | PARTIAL | INSUFFICIENT | MISSING_SCORE
    "provenance": {
      "windowDays": 14,
      "algoVersion": "deterministic-v2",
      "detectorVersion": "waste-v2",
      "detectorProfileVersion": "waste-thresholds-v1",
      "engineVersion": "reco-v2"
    },
    "organization": { "baseCurrency": "BRL", "recomputingCurrency": false },
    "page": { "nextCursor": "…", "hasMore": true }
  }
}
```

Nenhum número derivado sai sem `asOf` e sem a versão que o produziu (P7).

`evidenceSufficiency` tem **quatro** valores. `PARTIAL` é o que permite emitir um achado cuja
evidência é real mas degradada — benchmark de conta em vez de conjunto (§10.5), série curta,
componente medido por proxy — sem mentir que ele vale tanto quanto um achado de evidência plena.
Sem esse valor intermediário, o detector é forçado a escolher entre silêncio total e falsa
confiança, e §10.3 (que manda cair para a linha de base da conta) fica sem forma de se declarar.

### 7.0.2 Forma monetária

```jsonc
"incurred":       { "value": 1240.00, "currency": "USD",
                    "valueBase": 6820.00, "baseCurrency": "BRL",
                    "fxRate": 5.5, "fxAsOf": "2026-07-29" },
"avoidableDaily": { "value": 88.00, "currency": "USD",
                    "valueBase": 484.00, "baseCurrency": "BRL" }
```

Parâmetros de ação de orçamento aceitam **apenas** a moeda da conta (M3).

### 7.0.3 Escrita em plataforma é assíncrona

```http
POST /api/v1/ads/{id}/apply-recommendation
Idempotency-Key: 9f2c…

202 Accepted
Location: /api/v1/actions/executions/{executionId}
```
```jsonc
{
  "data": {
    "executionIds": ["uuid"],
    "recommendationStatus": "APPLYING",
    "ad": { "syncState": "PENDING_WRITE", "desiredStatus": "PAUSED", "observedStatus": "ACTIVE" },
    "verification": { "scheduledAt": "…", "ladder": ["90s","5m","30m","2h"] }
  }
}
```

**Nunca `200` com o estado novo.** A resposta expõe os dois estados para que a UI mostre
"pausando…", não "pausado". Um `PATCH` síncrono afirmaria que a mudança ocorreu quando ela está
apenas enfileirada — e a plataforma pode levar minutos, ou recusar.

### 7.0.4 Envelope de erro

```jsonc
{
  "error": {
    "code": "RECOMMENDATION_PREMISE_STALE",
    "category": "PRECONDITION_FAILED",
    "message": "As conversões deste anúncio foram re-declaradas pela plataforma.",
    "retryable": false,
    "details": { "reason": "WASTE_RESOLVED_BY_RESTATEMENT", "wasteItemIds": ["uuid"] },
    "remediation": "A recomendação foi expirada. Uma nova será gerada no próximo ciclo."
  }
}
```

| `category` | HTTP | Quando |
|---|---|---|
| `VALIDATION` | 400 | parâmetro inválido, moeda incorreta (M3) |
| `IDEMPOTENCY_KEY_REUSED` | 409 | mesma `Idempotency-Key`, payload diferente — não é replay, é erro do cliente |
| `NOT_PERMITTED` | 403 | RBAC insuficiente |
| `CONSENT_REQUIRED` | 403 | integração sem consentimento de escrita |
| `KILL_SWITCH` | 403 | `actionsEnabled = false` |
| `PRECONDITION_FAILED` | 409 | premissa da recomendação venceu |
| `WRITE_IN_FLIGHT` | 409 | já há escrita em voo no alvo (I2) |
| `CONFLICTING_RECOMMENDATION` | 409 | ação oposta pendente no mesmo alvo |
| `UNSUPPORTED_BY_PLATFORM` | 422 | capability declara não suportado (P6) |
| `PLATFORM_REJECTED` | 422 | plataforma recusou; erro dela em `details` |
| `INSUFFICIENT_EVIDENCE` | 422 | abaixo do piso de confiança ou maturidade |
| `RATE_LIMITED` | 429 | teto por integração ou organização |
| `INTEGRATION_UNREACHABLE` | 503 | credencial expirada ou plataforma fora |
| `CURRENCY_RECOMPUTING` | 503 | organização em `RECOMPUTING_CURRENCY` |

Num produto em que a ação move dinheiro, o erro é a informação. "Não dá para fazer isso" e "não dá
para fazer isso **agora**" pedem telas diferentes.

`IDEMPOTENCY_KEY_REUSED` existe porque "replay devolve o resultado original" é ambíguo no caso
perigoso: mesma chave com payload diferente devolveria, em silêncio, o resultado de **outra** ação.
`ActionExecution.requestDigest` distingue replay legítimo de colisão.

### 7.0.5 Paginação

Listas voláteis — `/ads`, `/waste/items`, `/recommendations`, `/actions/executions`, séries e
`/ads/{id}/history` — usam **cursor** (`?cursor=&limit=`). A ordenação padrão muda a cada ciclo;
offset produziria duplicatas e omissões entre páginas, além de não caber no p95 de 400 ms.

Listas de contexto (`/campaigns`, `/ad-sets`) mantêm `page`/`limit`.

## 7.1 Ads

Todas sob `/api/v1`, com `EntitlementGuard` + `OrganizationAccessGuard` + `X-Organization-Id`.

| Método | Rota | Notas |
|---|---|---|
| `GET` | `/ads` | cursor; exclui da ordenação quem está abaixo do piso de confiança, declarando quantos |
| `GET` | `/ads/{id}` | agregado + linhagem |
| `GET` | `/ads/{id}/analysis` | **estado por seção**, sempre `200` |
| `GET` | `/ads/{id}/scores` · `/metrics` | `?followLineage=true` (padrão) |
| `GET` | `/ads/{id}/waste` | inclui oportunidades separadas |
| `GET` | `/ads/{id}/recommendations` | inclui `blockedReason` e `DEFERRED_BY_CONFLICT` |
| `GET` | `/ads/{id}/actions` · `/history` · `/sync` | timeline tipada, cursor, segue linhagem |
| `POST` | `/ads/{id}/sync` · `/ads/sync-batch` | `202`; debounce 60 s; lote coalescido por conta |
| `POST` | `/ads/{id}/status-change` | `202` — substitui `PATCH /status` |
| `POST` | `/ads/{id}/apply-recommendation` | `202` + `Idempotency-Key` |
| `POST` | `/ads/{id}/resolve` · `/analyze` | |

```
&platform= &adAccountId= &campaignId= &adSetId= &creativeId=
&status= &syncState= &archived=
&hasOpenWaste= &hasOpenOpportunity= &minWasteAmountBase=
&scoreBelow= &scoreDroppedBy= &confidenceAbove= &dataMaturity= &lineageId=
&sortBy=avoidableDaily|wasteAmount|aiScore|spend|scoreDelta
&cursor= &limit=
```

> `sortBy=avoidableDaily` é o padrão sugerido: rankeia pelo que o usuário pode interromper hoje, não
> pelo que já perdeu.

## 7.2 Ações

| Método | Rota | Notas |
|---|---|---|
| `GET` | `/ads/{id}/actions/available` | `supported`, `reversible`, `requiresRecreate`, `createsEntity`, `validationDepth` |
| `POST` | `/ads/{id}/actions` | `202`; `origin` obrigatório; `Idempotency-Key` |
| `POST` | `/ads/{id}/actions/dry-run` | síncrono; devolve `validationDepth` alcançada |
| `GET` | `/actions/executions/{id}` · `/actions/executions` | cursor |
| `POST` | `/actions/executions/{id}/revert` | `202`; cria ação nova com `origin = REVERT` |
| `POST` | `/ads/actions/batch` | `202` + `batchId`; `origin` por item; máx. 100 |
| `GET` | `/ads/actions/batch/{id}` | progresso e **relatório por item** |

```jsonc
// GET /ads/actions/batch/{id}
{
  "data": {
    "status": "COMPLETED_WITH_ERRORS",
    "counts": { "total": 12, "succeeded": 9, "rejected": 2, "failed": 1 },
    "items": [
      { "adId": "…", "status": "SUCCEEDED", "executionId": "…" },
      { "adId": "…", "status": "REJECTED",
        "error": { "code": "RECOMMENDATION_PREMISE_STALE", "category": "PRECONDITION_FAILED" } }
    ]
  }
}
```

Cada item é revalidado individualmente; a recusa de um não aborta o lote. Dry-run com
`validationDepth: PLATFORM` é obrigatório acima de 10 itens.

## 7.3 Módulos

**Waste** — `GET /waste/summary` (par de grandezas; `openAmount` **deixa de existir**) ·
`/waste/items` (cursor, `+findingKind`, `+dataMaturity`, sem `level`) · `/waste/items/{id}` ·
`PATCH /waste/items/{id}/resolve` · `POST /waste/items/{id}/apply-fix` (`202`, resolve **todos** os
itens vinculados) · `/waste/by-ad` · `/waste/rollup` (janela declarada, via view `open_waste`) ·
`/waste/opportunities` ★. `GET /waste/impact` é **removida** em favor de
`/recommendations/impact-summary`.

**Recommendations** — `GET /recommendations` (cursor, `+advisory`, `+blockedReason`) · `/{id}` ·
`POST /{id}/apply` (`202`) · `POST /{id}/dismiss` (cria supressão com escopo e prazo) ·
`GET /recommendations/suppressions` · `DELETE /suppressions/{id}` · `/{id}/executions` ·
`/impact-summary` (três tipos separados; estimado e realizado na mesma unidade).

**Creatives** — `GET /creatives` · `/creatives/{id}/ads` (dispersão robusta, amostra, veredito com
confiança) · `/creatives/{id}/candidates` ★ · `/creatives/{id}/analyses` ·
`POST /creatives/{id}/optimize` ⚠ depreciado → `POST /ads/{id}/analyze`.
`POST /creatives/upload` — **fora do escopo da v2.0** (D7.1).

**Sync e integrações** — `GET /sync/operations` · `/sync/drift` (distingue `DRIFT` de
`EXTERNAL_CHANGE`) · `/sync/quarantine` ★ · `POST /sync/ad-accounts/{id}/reconcile` ·
`POST /integrations/{platform}/rebind` ★ (P10) ·
`POST /integrations/{id}/write-consent` · `DELETE` ★.

## 7.4 Contexto

Read-only, sem inteligência própria (P2): `GET /campaigns` · `/campaigns/{id}` ·
`/campaigns/{id}/ads` · `/ad-sets` · `/ad-sets/{id}` · `/ad-sets/{id}/ads`. Nenhum verbo de escrita
é exposto — não por convenção, por ausência de handler.

**Removidas por violarem P1:** `POST /campaigns`, `DELETE /campaigns/{id}`,
`POST /campaigns/ai/generate-title`, `POST /campaigns/ai/generate-description`,
`GET /campaigns/{id}/logs` (substituída por `GET /ads/{id}/history`).

## 7.5 Contratos de resposta

```jsonc
// AdRef — embutido em waste, recomendações, ações, alertas
{
  "id": "uuid",
  "lineageId": "uuid",
  "name": "BF25 | Vídeo 15s | Lookalike 1%",
  "platform": "META",
  "externalAdId": "23851234567890123",
  "observedStatus": "ACTIVE",
  "desiredStatus": null,
  "syncState": "IN_SYNC",
  "campaign": { "id": "uuid", "name": "Black Friday 2025" },
  "adSet":    { "id": "uuid", "name": "LAL 1% BR 25-44" },
  "creative": { "id": "uuid", "thumbnailUrl": "https://…", "format": "VIDEO" }
}
```

```jsonc
// GET /ads/{id}/analysis — estado por seção, sempre 200
{
  "data": {
    "ad": { /* AdRef */ },
    "score": {
      "status": "OK",
      "aiScore": 38.4, "confidence": 0.72, "componentCoverage": 1.0,
      "seriesDiscontinuity": null,
      "scoredAt": "…", "algoVersion": "deterministic-v2",
      "components": {
        "attention": { "value": 31.2, "normalizedValue": 31.2, "available": true,
                       "confidence": 0.81, "reasons": ["Thumbstop 12% vs. 24% da conta"] },
        "fatigue":   { "value": 0.78, "normalizedValue": 22.0, "available": true,
                       "confidence": 0.88, "reasons": ["Frequência 5.2, CTR -41% em 7d"] }
      },
      "context": { "saturationRisk": { "value": 0.61, "scopeLevel": "AD_SET" } },
      "delta": { "vsPrevious": -12.6, "vs7d": -18.1, "trend": "DECLINING" },
      "narrative": "…"
    },
    "creativeAnalysis": { "status": "PENDING" },
    "openWaste":        { "status": "OK", "items": [ /* … */ ] },
    "opportunities":    { "status": "OK", "items": [] },
    "recommendations":  { "status": "UNAVAILABLE", "reason": "CURRENCY_RECOMPUTING" }
  },
  "meta": { "asOf": "…", "dataMaturity": "MATURE", "provenance": { /* … */ } }
}
```

```jsonc
// Recommendation
{
  "id": "uuid",
  "ad": { /* AdRef */ },
  "kind": "PAUSE_UNDERPERFORMING_AD",
  "advisory": false,
  "title": "Pausar \"BF25 | Vídeo 15s | Lookalike 1%\" — R$ 1.240 sem conversão",
  "rationale": "14 dias, R$ 1.240,00 gastos, 0 conversões. AI Score 38 e caindo.",
  "impacts": [
    { "type": "SAVINGS",
      "estimated": { "value": 2640.00, "currency": "BRL", "horizonDays": 30 },
      "realized": null, "confidence": 0.78 }
  ],
  "priority": "CRITICAL", "status": "NEW",
  "evidenceAsOf": "…", "expiresAt": "…",
  "wasteItems": [ { "id": "uuid", "type": "ZERO_CONVERSIONS" } ],
  "actions": [
    { "id": "uuid", "type": "PAUSE_AD", "level": "AD",
      "parameters": { "adId": "uuid" },
      "supported": true, "reversible": true, "createsEntity": false,
      "validationDepth": "PLATFORM", "aiAuthored": false,
      "estimatedEffect": "Interrompe R$ ~88/dia de gasto" }
  ]
}
```

```jsonc
// Recomendação consultiva
{
  "kind": "EXPAND_AUDIENCE",
  "advisory": true,
  "actions": [],
  "outOfScopeReason": "Expandir público é feito no gerenciador da plataforma. A Allva não gere audiências.",
  "guidance": "O público deste conjunto está saturado: frequência 6,2 e alcance estagnado há 9 dias."
}
```

---

# 8. Sincronização

## 8.1 Cinco fluxos

```text
① INGEST        (inbound, agendado)     AdAccount → estrutura + métricas em nível AD
② REFRESH       (inbound, dirigido)     Ad        → status + métricas, sob demanda
③ WRITE-THROUGH (outbound)              Ação      → plataforma → estado otimista
④ RECONCILE     (inbound, verificação)  AdAccount → drift, mudança externa, frescor
⑤ REBIND        (inbound, identidade)   Integração nova → mesma identidade  (P10)
```

## 8.2 ① Ingest

```text
 1. Adquire lock da AdAccount (advisory). Já em execução ⇒ encerra sem erro.
 2. Resolve credencial via AdAccount.integrationId; refresh de token se expirando.
 3. Abre SyncOperation(INBOUND, FULL_ACCOUNT | STRUCTURE_ONLY | METRICS_ONLY).
 4. ESTRUTURA — incremental por updated_since desde o último sync bem-sucedido;
    varredura completa em cadência diária. Paginação com cursor persistido em
    SyncOperation.checkpoints a cada página.
 5. Upsert em ordem de FK, resolvendo external ids por adAccountId (P10).
    Ad sem campanha/adset resolvível ⇒ sync_quarantine — não aborta e não descarta.
 6. MÉTRICAS — insights EXCLUSIVAMENTE em nível AD, sobre a janela de re-declaração
    rolante (AdAccount.restatementWindowDays = max(env, attributionWindowDays)).
 7. Normalização monetária via Currency Normalization Service; sem taxa,
    grava normalizationPending = true e segue.
 8. Grava observedStatus com guarda de recência (§8.4.1) e observedAsOf.
 9. ARQUIVAMENTO — somente se 4–6 concluíram com sucesso e a resposta foi completa.
10. Emite ad.discovered / ad.metrics.updated / ad.status.changed / ad.archived.
11. Fecha SyncOperation com contadores, wasComplete e stepResults por etapa.
```

**A guarda do passo 9 é a correção central.** "Não visto" só significa "não existe mais" quando
**conseguimos ver tudo**. Falha, timeout, paginação incompleta, escopo reduzido ou permissão
revogada levam a conta a `UNREACHABLE`; nenhum anúncio é arquivado. Sem essa guarda, uma reconexão
com escopo menor arquiva milhares de anúncios ativos, fecha todo o desperdício aberto como `STALE` e
zera o número de capa sem que nada tenha acontecido com a mídia.

**Janela de re-declaração.** As plataformas reescrevem o passado: conversões chegam atribuídas a
dias anteriores dentro da janela de atribuição, gasto sofre ajuste por tráfego inválido, receita
chega atrasada. Cada ingest re-busca os últimos N dias e faz upsert por `(adId, date, granularity)`.

**A janela é por CONTA, não por organização.** Duas contas da mesma organização podem ter janelas de
atribuição de 7 e de 28 dias — tratar as duas com o mesmo N faria a de 28 perder conversões
retroativas sistematicamente, e sempre nas mesmas condições, o que é indistinguível de desempenho
ruim. Por isso `restatementWindowDays` mora em `AdAccount` (§4.1) e não em `OrganizationAdsSettings`.

## 8.3 ② Refresh dirigido por Ad

```text
Ad → credencial via AdAccount → fetch de UM ad (status + insights da janela)
   → upsert de snapshot + observedStatus com guarda de recência
   → recomputa AdScore se inputDigest mudou
   → reavalia waste aberto do ad
   → SyncOperation(kind = AD_REFRESH, adId)
```

Debounce de 60 s por anúncio; orçamento compartilhado com o ingest pelo token bucket de
`platform-clients`. `POST /ads/sync-batch` coalesce ids por conta numa única chamada de insights.

## 8.4 ③ Write-through

```text
ExecuteActionUseCase
  1. valida capability, política de segurança, consentimento e kill switch
  2. verifica I2: existe execução não terminal para este ALVO? ⇒ 409 com o id em voo
  3. captura previousState → AdAction.previousState
  4. cria ActionExecution(QUEUED, idempotencyKey do cliente) com expiresAt
  5. grava Ad.desiredStatus + desiredStatusSetAt + syncState = PENDING_WRITE
  6. enfileira; worker chama AdActionGateway.execute()
  7. sucesso → SUCCEEDED, persiste resultPlatformEntityId
     falha   → FAILED | REJECTED_BY_PLATFORM, reverte desiredStatus, libera I2
  8. agenda escada de verificação: T+90s, T+5min, T+30min, T+2h
  9. emite action.executed
```

**Por que estado otimista + verificação.** A escrita retornar `200` não significa que a plataforma
aplicou — Meta processa de forma assíncrona; Google pode aplicar parcialmente. Sem `desiredStatus`
separado de `observedStatus`, o próximo ingest sobrescreveria o resultado da ação e o produto
reportaria sucesso sem saber.

### 8.4.1 Guarda de recência

```text
se observedAsOf > desiredStatusSetAt  → grava status e métricas
senão                                 → grava métricas, IGNORA o status
```

`observedAsOf` é o instante **do dado na plataforma**, não o da gravação local. Um ingest iniciado
antes de uma ação e concluído depois gravaria um status obsoleto, e a reconciliação declararia
`DRIFTED` num anúncio que obedeceu. Em contas grandes a janela entre buscar e gravar é de minutos —
o cenário é o caso comum, não a exceção.

**Fallback obrigatório.** `PlatformProfile.sync.exposesDataTimestamp` admite plataformas que não
expõem o instante do dado. Com `observedAsOf` nulo a guarda seria indefinida — e ela é justamente a
proteção contra o produto alertar sobre uma divergência que ele mesmo criou. O ingest sempre
preenche o campo:

```text
observedAsOf       = expõe timestamp ? timestamp da plataforma : SyncOperation.startedAt
observedAsOfSource = PLATFORM | SYNC_START
```

`SyncOperation.startedAt` é o **limite inferior seguro**: o dado não pode ser mais novo que o
instante em que a leitura começou. A guarda fica bem definida em toda plataforma, e o erro cai do
lado certo — na dúvida, **não** sobrescreve o status.

## 8.5 ④ Reconciliação

**(a) Drift — divergência da nossa intenção.** Apenas para ads com `desiredStatus != null`:

```text
observed == desired  →  IN_SYNC, CONFIRMED, limpa desiredStatus, libera I2
observed != desired  →  dentro da graça (5 min)          → segue PENDING_WRITE
                        fora da graça, escada não esgotada → próxima tentativa
                        escada esgotada                    → DRIFTED
                                                             INCONCLUSIVE
                                                             driftCause = UNVERIFIED_WRITE
                                                             execução vai a estado terminal
                                                             libera I2 e alerta
```

O último ramo impede o travamento permanente: sem estado terminal, I2 manteria o anúncio
indefinidamente sem aceitar novas ações, em silêncio.

**(b) Mudança externa — alteração que não pedimos.** Para **todos** os ads, inclusive os que a Allva
nunca tocou: compara `observedStatus` com a observação anterior. Mudança sem ação correspondente
emite `ad.status.changed` com `source = EXTERNAL` e a causa provável em `driftDetails` (reprovado
pela plataforma, pausado por regra de budget, alterado por um operador). É informação de produto —
e alimenta o sinal de P3.

**(c) Frescor.** `lastMetricsSyncAt` acima do SLA ⇒ `STALE` para scoring e detecção;
`lastStructureSyncAt` acima do SLA ou integração indisponível ⇒ `UNREACHABLE`. Um anúncio `STALE`
por métrica continua apto a receber ação; um `UNREACHABLE` não.

## 8.6 ⑤ Rebind — reconexão preservando identidade (P10)

```text
RebindIntegrationUseCase(organizationId, platform, novaIntegration)
  1. lista contas de anúncios acessíveis pela nova credencial
  2. casa por (organizationId, platform, externalAccountId) — NUNCA por integrationId
  3. conta já conhecida    → adAccount.integrationId = nova; preserva todo o histórico
     conta nova            → cria AdAccount; ingest inicial
     conta agora inacessível → syncState = UNREACHABLE + alerta
                             NÃO arquiva ads · NÃO resolve waste · NÃO expira recomendações
  4. credencial antiga revogada; a linha de Integration é preservada para auditoria
  5. audit: integration.rebound
```

Perder acesso a uma conta é evento de **visibilidade**, não de mídia: os anúncios continuam
existindo e gastando.

## 8.7 Degradação declarada

| Condição | Onde é lida | Ingest | Scoring | Detecção | Recomendações | Ações |
|---|---|---|---|---|---|---|
| Normal | `AdAccount.syncHealth = HEALTHY` | roda | roda | roda | roda | permitidas |
| `UNREACHABLE` | `AdAccount.syncHealth` | falha e reporta | pausa | **pausa** | pausa | bloqueadas |
| `DEGRADED` | `AdAccount.syncHealth` | roda | pausa | pausa | pausa | permitidas |
| `STALE` métrico | `Ad.syncState` | roda | pausa | pausa | pausa | permitidas |
| `normalizationPending` | `AdMetricSnapshot` | roda | ignora as linhas | ignora as linhas | — | permitidas |
| `RECOMPUTING_CURRENCY` | `Organization.currencyState` | roda sem normalizar | pausa | pausa | pausa | permitidas (M3) |

A coluna "onde é lida" não é decoração: as três primeiras linhas são estado **de conta** e as duas
seguintes são estado **de anúncio** e **de linha**. Sem `AdAccount.syncHealth` (§4.1, R-H), as três
primeiras não teriam sujeito, e a degradação seria uma tabela sem implementação possível.

**A linha `UNREACHABLE` da coluna de detecção é normativa.** O auto-resolve só pode concluir que "a
condição cessou" a partir de **observação válida**. Sem sync bem-sucedido, os itens abertos
permanecem abertos com `staleObservation = true`. **Ausência de dado nunca é evidência de
resolução.**

## 8.8 Agendamento e idempotência

| Job | Frequência | Escopo | Lease | Depende de |
|---|---|---|---|---|
| `ads-ingest` (incremental) | horária | AdAccount ativa | 30 min | — |
| `ads-ingest-full` | diária | AdAccount ativa | 60 min | — |
| `ad-account-discovery` | diária | Integration ativa | 15 min | — |
| `ads-reconcile` | 6/6h + escada pós-write | contas com writes recentes | 15 min | — |
| `ad-scoring` | diária | AdAccount | 30 min | `ads-ingest*` do dia `SUCCEEDED` |
| `waste-detection` | diária | AdAccount | 30 min | `ad-scoring` do dia `SUCCEEDED` |
| `recommendations-generation` | diária | organização | 30 min | `waste-detection` de todas as contas |
| `fx-rates-collection` | diária | moedas observadas × pivô | 15 min | — |
| `fx-rates-backfill` ★ | sob demanda | moeda nova · deploy | 60 min | — |
| `metrics-partition-maintenance` ★ | mensal | global | 15 min | — |
| `action-execution-reaper` ★ | 5 min | global | 5 min | — |
| `denormalization-reconcile` ★ | diária | organização | 30 min | `waste-detection`, `ad-scoring` |
| `recommendation-lifecycle` ★ | horária | organização | 15 min | — |
| `recommendation-outcome-measure` ★ | diária | organização | 30 min | `ads-ingest*` do dia |
| `ad-refresh` | sob demanda | ad | — (debounce 60 s) | — |

★ ausentes na primeira redação. Cada um mantém uma invariante que o documento declara e que nenhum
processo cumpria: partições futuras (G4), liberação de I2, coerência das denormalizações (§5.4 r.2),
expiração de recomendações e supressões, e a persistência de outcome que P8 exige.

**A ordem é dado, não convenção.** "Após o ingest" não é executável enquanto for uma palavra. Cada
job resolve a dependência consultando `JobRun`:

```sql
SELECT 1 FROM job_runs
 WHERE job_name='ads-ingest-full' AND scope_type='AD_ACCOUNT'
   AND scope_id=$1 AND window_key=$2 AND status='SUCCEEDED';
-- ausente ⇒ JobRun(SKIPPED, skip_reason='UPSTREAM_NOT_READY'), sem erro
```

A cadeia dirigida por evento é o caminho normal; o cron é rede de segurança permanente. Antes de
executar, o job adquire a janela pelo takeover condicional de §4.7. Sem isso, cada janela é
processada duas vezes — dobrando custo de LLM (P9) e inflando `occurrences`, que é sinal usado por P8.

**O lease é por tipo de job.** O heartbeat roda a `lease/3`. Ingest de 5k ads tem alvo de < 5 min
(§17.2) e cabe folgado em 30; um backfill de 400 dias de FX, não. Lease curto demais faz um worker
saudável perder a posse no meio; longo demais faz uma janela ficar bloqueada até o dobro do tempo
necessário quando um worker morre.

## 8.9 Maturidade do dado

```text
maturidade(dia D) = hoje − D  em relação à janela de atribuição da conta

  IMMATURE   dentro da janela de atribuição   → métricas ainda vão mudar
  SETTLING   até 2× a janela                  → mudanças residuais
  MATURE     além disso                       → estável para decisão
```

| Regra | |
|---|---|
| `ZERO_CONVERSIONS`, `LOW_ROAS`, `HIGH_CPA` | só disparam sobre janela **`MATURE`** |
| `LOW_CTR`, `CREATIVE_FATIGUE`, `NEGATIVE_FEEDBACK` | podem usar `SETTLING` — impressão e clique não são re-declarados |
| `AdScore` | calcula em qualquer maturidade, mas `confidence` cai proporcionalmente |
| Toda resposta de API | expõe `dataMaturity` junto de `asOf` |

> `ZERO_CONVERSIONS` origina `PAUSE_UNDERPERFORMING_AD`, a ação mais destrutiva e mais frequente do
> catálogo. Disparar sobre dado imaturo significa recomendar pausar anúncios que converteram — e o
> usuário descobre isso na plataforma, não na Allva.

Um item que desaparece porque o dado foi re-declarado é **falso positivo**, não sucesso:
`RESOLVED_BY_RESTATEMENT` o separa de `RESOLVED_EXTERNALLY`, preservando a honestidade do dataset
de P8.

---

# 9. Recommendation Engine

## 9.1 O agregado

```text
Recommendation  (raiz do plano)
   ├── ad: Ad                       ← Target primário, FK obrigatória
   ├── wasteItems: WasteItem[]      ← N:N — um plano responde a vários sinais
   ├── kind + advisory              ← advisory: remédio fora do escopo da Allva
   ├── evidence + evidenceAsOf + expiresAt
   ├── impacts[]                    ← SAVINGS · EFFICIENCY_GAIN · REVENUE_UPLIFT, separados
   └── actions: AdAction[]          ← EXECUTÁVEIS (vazio quando advisory)
          └── executions → verificationResult
   └── outcome: RecommendationOutcome?   ← P8
```

## 9.2 Alvo e nível da ação

O alvo primário é sempre um `Ad`. O `level` (`AD`/`AD_SET`/`CAMPAIGN`) é propriedade da **ação**. A
recomendação continua sendo *sobre o anúncio* — *"este anúncio está sendo sufocado por orçamento"* —
e a ação carrega o nível com aviso de escopo:

```jsonc
{
  "type": "ADJUST_CAMPAIGN_BUDGET",
  "level": "CAMPAIGN",
  "parameters": { "campaignId": "uuid", "dailyBudget": 500.00, "currency": "BRL" },
  "scopeWarning": "Afeta os 8 anúncios desta campanha, não apenas este."
}
```

**Resolução por nível.** A política declara alternativas ordenadas, resolvidas contra
`PlatformProfile.hierarchy.budgetLevels`:

```text
REDUCE_BUDGET_HIGH_CPA:
   1ª opção  ADJUST_AD_SET_BUDGET      ← ad set tem orçamento próprio
   2ª opção  ADJUST_CAMPAIGN_BUDGET    ← CBO ativo, com scopeWarning
   fallback  advisory                  ← nenhum nível disponível
```

Descartar a ação é o último recurso; quando acontece, a recomendação vira **consultiva** com
`outOfScopeReason` — nunca uma recomendação vazia e silenciosa.

## 9.3 Catálogo

| `RecommendationKind` | Origem | Ações | Guardas |
|---|---|---|---|
| `PAUSE_UNDERPERFORMING_AD` | `ZERO_CONVERSIONS`, `LOW_ROAS` | `PAUSE_AD` | maturidade `MATURE` |
| `REFRESH_FATIGUED_CREATIVE` | `CREATIVE_FATIGUE` | `REPLACE_CREATIVE`, `PAUSE_AD` | **criativo substituto disponível** |
| `IMPROVE_WEAK_HOOK` | `LOW_CTR`, attention baixo | `REPLACE_CREATIVE`, `REPLACE_COPY` | aviso de `requiresRecreate` |
| `REPLACE_CTA` | audienceFit ok + conversão baixa | `REPLACE_CTA` | aviso de `requiresRecreate` |
| `MITIGATE_NEGATIVE_FEEDBACK` | `NEGATIVE_FEEDBACK` | `PAUSE_AD` | sinais reais presentes |
| `REDUCE_BUDGET_HIGH_CPA` | `HIGH_CPA` | `ADJUST_AD_SET_BUDGET` → `ADJUST_CAMPAIGN_BUDGET` | ≥ 3 conversões |
| `STABILIZE_LEARNING` | `LEARNING_INSTABILITY` | `ADJUST_AD_SET_BUDGET` | — |
| `CONSOLIDATE_OVERLAP` | `OVERLAPPING_DELIVERY` | `PAUSE_AD` | atribuição determinística |
| `EXPAND_AUDIENCE` | `AUDIENCE_SATURATION` | — **consultiva** | — |
| `SCALE_WINNING_AD` | oportunidade `BUDGET_STARVATION`; `aiScore ≥ 75` e ROAS ≥ 2× mediana | `ADJUST_AD_SET_BUDGET`, `DUPLICATE_AD` | **seis guardas abaixo** |

`SCALE_WINNING_AD` é o contrapeso deliberado: um produto que só sabe pausar reduz gasto mas não
melhora resultado. E é a **única recomendação que aumenta gasto** — sob P5, a que exige mais
evidência.

| Guarda | Bloqueia quando |
|---|---|
| Fadiga | `fatigueScore ≥ 0.5` ou fadiga em alta nos últimos 7 dias |
| Saturação | achado `AUDIENCE_SATURATION` aberto no anúncio ou no conjunto |
| Frequência | acima do limiar do `DetectorProfile` |
| Confiança | `aiConfidence < 0.70` — anúncio novo não é anúncio campeão |
| Maturidade | janela não é `MATURE` — ROAS é re-declarado |
| Estabilidade | `learningStability` baixo — escalar em aprendizado instável o reinicia |

O `aiScore` composto **inclui** fadiga com peso 0,15 invertido: um anúncio com attention 90,
audienceFit 90 e fatigue 0,70 cruza os 75 pontos. É o perfil do criativo campeão em fim de vida —
e aumentar orçamento nele acelera exatamente o que o está matando.

Bloqueio não some em silêncio: gera a recomendação com `blockedReason` visível
("candidato a escala, retido por fadiga"), que é informação ao usuário e sinal de calibração (P8).

## 9.4 Geração

```text
GenerateRecommendationsUseCase(organizationId)

 1. GUARDA: organização com sync válido e sem recomputo de moeda em curso
 2. carrega ads com waste/oportunidade aberto OU score fora de faixa
 3. por ad:
      a. reúne sinais: waste items, AdScore corrente, delta, contexto do ad set
      b. RecommendationPolicy (domínio puro) → RecommendationPlan[]
      c. aplica guardas do kind
      d. consulta SUPRESSÕES ativas
      e. resolve nível da ação por PlatformProfile; replaneja antes de descartar
      f. define evidenceAsOf e expiresAt
 4. RESOLUÇÃO DE CONFLITO — agrupa TODOS os planos por ALVO DE AÇÃO
      (entityType, entityId), não por anúncio:
        ações opostas no mesmo alvo → vence maior prioridade e maior avoidableDaily
        perdedora → DEFERRED_BY_CONFLICT, com o conflito explicitado
 5. persiste Recommendation + AdAction[] + vínculos N:N
      primaryImpactType definido aqui, pela regra fixa do kind (§4.5)
 6. supersede a geração anterior do mesmo (ad, kind) → SUPERSEDED
 7. expira recomendações cujos waste de origem foram todos resolvidos → EXPIRED
 8. REABILITA as diferidas cujo conflito deixou de existir:
      conflito resolvido + premissa ainda válida → volta a NEW
      conflito resolvido + premissa vencida      → EXPIRED
 9. enriquecimento IA opcional: só title e rationale (P4)
```

**O passo 8 impede um estado terminal acidental.** `DEFERRED_BY_CONFLICT` é o único status não
terminal sem caminho de saída declarado: quando a recomendação vencedora é aplicada ou expira, o
conflito desaparece — mas a perdedora ficaria presa nesse estado para sempre, e o problema que ela
descreve continua queimando dinheiro sem nunca voltar à tela.

**O passo 4 é estrutural.** Deduplicar por `(ad, kind)` não evita conflito porque a ação
frequentemente mira acima do anúncio. Dois anúncios do mesmo conjunto — um com `HIGH_CPA`, outro
campeão — geram `ADJUST_AD_SET_BUDGET` em direções opostas sobre a mesma entidade, ambos válidos
isoladamente, ambos oferecidos ao usuário.

**O passo 3d mantém o motor vivo.** Um motor que reapresenta amanhã o que o usuário rejeitou hoje
não morre por errar — morre por não escutar. A taxa de dispensa por `kind` é métrica de produto:
assim como `USER_DIRECT` sinaliza recomendação faltante (P3), dispensa recorrente sinaliza política
errada (P8).

## 9.5 Aplicação

```text
POST /ads/{id}/apply-recommendation  { recommendationId, dryRun?, Idempotency-Key }

 1. REVALIDAÇÃO DE PREMISSA — antes de qualquer escrita:
      • recomendação NEW|ACKNOWLEDGED, não expirada, não suprimida
      • waste items vinculados ainda ABERTOS
      • evidenceAsOf dentro do prazo; maturidade ainda sustenta o veredito
      • ad ativo, observável, não arquivado, integração alcançável
      • capability suportada; consentimento válido; kill switch off
      • nenhuma escrita em voo no ad NEM no alvo da ação (I2 generalizada)
      ⇒ premissa vencida: 409 tipado, recomendação expirada na hora, motivo visível
 2. autorização RBAC por tipo de ação
 3. dryRun → validate() com profundidade declarada; devolve plano e efeito estimado
 4. real → APPLYING; para cada ação, ExecuteActionUseCase (§8.4)
 5. todas SUCCEEDED → APPLIED; alguma FAILED → FAILED com detalhe por ação
 6. NA MESMA TRANSAÇÃO que grava appliedAt, cria RecommendationOutcome:
      status = PENDING_MEASUREMENT
      fxRateFixed = taxa de appliedAt (M4)
      preSpendBase, preRevenueBase, preConversions  ← janela [appliedAt − windowDays, appliedAt)
      preAiScore = Ad.currentAiScore no instante
      lineageId  = Ad.lineageId
 7. ação com createsEntity → registra expectativa de recriação para o sync casar
 8. resolve TODOS os waste items vinculados com RESOLVED_BY_ACTION
 9. audit: ad.recommendation.applied, com origin
10. agenda escada de verificação; o job de medição fecha a janela pós sobre a LINHAGEM
```

**O passo 6 é o que torna P8 honesto.** Reconstruir o "pré" dias depois lê dado que a plataforma já
re-declarou (§8.9) — o dataset de acurácia nasceria contaminado exatamente pelo fenômeno que o
produto sabe existir e mede em toda parte. O pré é um fato do instante da aplicação; capturá-lo
depois é inferi-lo.

É por isso que os campos `post*`, `verdict` e `measuredAt` de `RecommendationOutcome` são nullable
(§4.5): a linha nasce incompleta, por construção.

**O passo 1 separa um copiloto de um gerador de acidentes.** A recomendação é gerada num lote diário
e aplicada quando o usuário clica, dias depois. No intervalo, conversões são re-declaradas
retroativamente, o anúncio pode ter sido pausado na plataforma, o token pode ter expirado. Sem
revalidação, o clique executa uma decisão tomada sobre um mundo que já não existe — e registra o
resultado como acerto no dataset de P8.

**O passo 6 fecha a linhagem.** Ações com `requiresRecreate` fazem a plataforma criar um anúncio novo
e arquivar o antigo. Sem o casamento entre `resultPlatformEntityId` e o `externalAdId` descoberto no
ingest seguinte, o anúncio novo nasce órfão e o outcome mede o antigo — lendo "gasto foi a zero"
como sucesso absoluto, quando o gasto apenas migrou para fora do campo de visão.

## 9.6 Reversão

Reverter é **uma ação nova**, nunca um atalho:

```text
POST /actions/executions/{id}/revert
  → cria AdAction(origin = REVERT, revertedByActionId ← ação original)
  → parâmetros derivados de previousState
  → própria ActionExecution, própria idempotencyKey, própria verificação
  → sujeita a I2, RBAC, kill switch e auditoria como qualquer escrita
```

`AdActionGateway.revert()` permanece como **transporte**, invocado pelo worker — nunca chamado
diretamente por um controller. Uma escrita em mídia paga fora do caminho auditado viola P5.

## 9.7 Impacto

| Tipo | Natureza | Confiança típica |
|---|---|---|
| `SAVINGS` | gasto interrompido — verificável diretamente | alta |
| `EFFICIENCY_GAIN` | CPA/ROAS melhorado com gasto comparável | média |
| `REVENUE_UPLIFT` | receita adicional projetada | baixa — sazonalidade, leilão, saturação |

Reportados **separadamente**, nunca somados. O estimado é sempre projeção de
`avoidableDailyAmount` sobre horizonte declarado (§10.1), o que o torna comparável com
`RecommendationOutcome.observedDelta` medido depois.

**O realizado tem uma casa só.** `Recommendation.impacts[]` guarda **apenas o estimado**;
`RecommendationOutcome` é a fonte de verdade do medido. `/recommendations/impact-summary` compõe os
dois por join. Persistir o realizado nos dois lugares os faria divergir em silêncio — e a que erra é
sempre a projeção, que ninguém revisita.

**Um delta primário, não uma soma.** Uma recomendação com estimativa de `SAVINGS` **e**
`EFFICIENCY_GAIN` produz uma única medição, a de `primaryImpactType` (tabela em §4.5). Os demais vão
para `secondaryDeltas` como contexto e não entram nas métricas de acurácia de P8 — senão a mesma
recomendação seria contada duas vezes no denominador que autoriza a automação de §20-H3.

> **Limite honesto.** Isto é medição pré/pós, não atribuição causal. O contrato rotula
> `observedDelta`, nunca `causedSavings`, e expõe `confounders` quando detectáveis (D6).

---

# 10. Waste Detector

## 10.1 Princípio

> Desperdício é sempre gasto de **um anúncio**. Campanha e conjunto não desperdiçam — eles somam o
> desperdício dos seus anúncios.

**Segundo princípio, de igual peso:** o produto reporta **duas** grandezas, nunca uma.

| Grandeza | Direção | Pergunta que responde |
|---|---|---|
| `incurredAmount` | passada | "quanto já queimei com este problema?" |
| `avoidableDailyAmount` | futura | "quanto estou queimando por dia se não fizer nada?" |

A primeira é diagnóstico e histórico. A segunda justifica a urgência, é o que a ação interrompe, e é
a **única comparável** com o impacto medido depois. Reportar só a primeira faz o produto prometer
uma recuperação que não existe: aquele dinheiro já foi.

## 10.2 Desperdício e oportunidade

```prisma
enum FindingKind { WASTE  OPPORTUNITY }
```

```sql
-- Toda agregação de desperdício passa obrigatoriamente por aqui.
CREATE VIEW open_waste AS
  SELECT * FROM waste_items
   WHERE finding_kind = 'WASTE' AND resolved_at IS NULL;
```

Um anúncio saudável sufocado por orçamento é **oportunidade** — dinheiro que deixou de ser ganho,
não gasto mal. Os dois compartilham a maquinaria de ciclo de vida e **jamais** se misturam em
agregados. A separação é garantida pela view, não pela disciplina de quem escreve a consulta.

## 10.3 Arquitetura de detectores

```typescript
export type DetectionContext = {
  ad: AdSnapshotView;              // agregado do ad na janela, em moeda-base (M1)
  adSetPeers: AdSnapshotView[];    // pares do MESMO ad set — benchmark correto
  accountBaseline: Baseline;       // mediana e percentis da conta
  score: AdScoreView | null;
  windowDays: number;
  dataMaturity: DataMaturity;
  profile: DetectorProfile;
};

export interface AdScopedDetector {
  readonly scope: 'AD';
  readonly type: FindingType;
  readonly version: string;
  readonly minimumEvidence: EvidenceGate;
  readonly requiresMaturity: DataMaturity;
  detect(ctx: DetectionContext): Finding | null;
}

export interface AdSetScopedDetector {
  readonly scope: 'AD_SET';
  /** Avalia o conjunto e devolve achados JÁ ATRIBUÍDOS a anúncios específicos. */
  detect(ctx: AdSetDetectionContext): Finding[];
}
```

**Benchmark.** O anúncio compara-se primeiro com os pares do mesmo ad set — mesmo público, mesmo
objetivo, mesmo leilão — e cai para a linha de base da conta com menos de 3 pares. **Mediana e
percentis, nunca média**: um outlier de CPA não pode arrastar o benchmark.

O fallback é **declarado, não silencioso**, e vem com limiar mais conservador:

| Pares no ad set | Benchmark | `scopeLevel` | Limiar | `evidenceSufficiency` |
|---|---|---|---|---|
| ≥ 3 | mediana do ad set | `AD_SET` | nominal | `SUFFICIENT` |
| < 3 | mediana da conta | `AD_ACCOUNT` | **1,5× o nominal** | `PARTIAL` |
| conta com < 3 ads ativos | — | — | **não dispara** | `INSUFFICIENT` |

A alternativa — exigir 3 pares como condição de disparo — silenciaria contas inteiras: um anúncio por
ad set é a estrutura mais comum em contas pequenas, exatamente onde desperdício dói mais. A
recomendação derivada herda a confiança reduzida.

**Atribuição determinística para a família `AD_SET`.** Achados relacionais recaem sobre o anúncio de
**menor `aiScore`**; empate por menor `id`. Os demais constam em `evidence.relatedAdIds`, com
`scopeLevel: AD_SET` e `attributionRule`. O determinismo é o que mantém o fingerprint estável entre
execuções — sem ele, a deduplicação quebra e o mesmo problema reaparece como item novo a cada ciclo.

**Evidência mínima.** Todo detector declara `minimumEvidence`. Abaixo dela devolve `null` e a
insuficiência é reportada, nunca convertida em ausência de problema (P7). Score ausente é
insuficiência: `evidenceSufficiency: MISSING_SCORE`.

## 10.4 Configuração de limiares

```typescript
export type DetectorProfile = {
  version: string;                 // "waste-thresholds-v1"
  organizationId: string | null;   // null = padrão global
  thresholds: Record<FindingType, ThresholdSet>;
  provenance: string;              // origem: análise de base, calibração, decisão de produto
  effectiveFrom: Date;
};
```

Limiares deixam de ser literais no corpo dos detectores. `WasteItem` grava
`detectorProfileVersion` além de `detectorVersion` — é isso que torna P7 verificável ("por que este
anúncio foi marcado?") e P8 possível (calibrar sem deploy, comparar configurações).

**Mudança de profile não é mudança de detector.** Trocar um limiar não dispara
`SUPERSEDED_BY_DETECTOR`: o achado é o mesmo, o corte é que mudou. Só a troca de `detectorVersion` —
mudança de lógica — tem esse efeito.

## 10.5 Catálogo

| Tipo | `kind` | Condição | `incurred` | `avoidableDaily` | Evidência mínima | Maturidade | Recomendação |
|---|---|---|---|---|---|---|---|
| `ZERO_CONVERSIONS` | WASTE | `conversions = 0` e `spend ≥ max(p_min, 3× CPA mediano)` | `spend` | gasto médio diário 7d | `spend ≥ p_min`, ≥ 5 dias | **MATURE** | `PAUSE_UNDERPERFORMING_AD` |
| `LOW_ROAS` | WASTE | `roas < 1` e `spend ≥ p_min` | `spend − revenue` | déficit diário 7d | `spend ≥ p_min`, ≥ 1 conversão | **MATURE** | `PAUSE_UNDERPERFORMING_AD` |
| `HIGH_CPA` | WASTE | `cpa > 2× mediana do adset` (pares ≥ 3) ou `> 3× mediana da conta` (pares < 3) | `spend − (conv × cpa mediano)` | excedente diário 7d | **≥ 3 conversões no anúncio** | **MATURE** | `REDUCE_BUDGET_HIGH_CPA` |
| `LOW_CTR` | WASTE | `ctr < p25 do adset` | `spend × (1 − ctr/p50)` | proporcional diário | `impressions ≥ 1000` | SETTLING | `IMPROVE_WEAK_HOOK` |
| `CREATIVE_FATIGUE` | WASTE | `fatigueScore ≥ t` | `spend × fatigue × 0.5` | proporcional diário | score presente, ≥ 7 dias | SETTLING | `REFRESH_FATIGUED_CREATIVE` |
| `NEGATIVE_FEEDBACK` | WASTE | `negativeFeedbackRisk ≥ t` | `spend × 0.4` | proporcional diário | sinais reais presentes | SETTLING | `MITIGATE_NEGATIVE_FEEDBACK` |
| `LEARNING_INSTABILITY` | WASTE | `learningStability < t` e `spend ≥ p_min` | `spend × 0.25` | proporcional diário | ≥ 7 dias de série | SETTLING | `STABILIZE_LEARNING` |
| `AUDIENCE_SATURATION` | WASTE | `frequency` média 7d `> t`, slope de frequência `> 0`, impressões estáveis ou em queda — **escopo AD_SET** | `spend × 0.35` | proporcional diário | ≥ 7 dias com `frequency` | SETTLING | `EXPAND_AUDIENCE` (consultiva) |
| `OVERLAPPING_DELIVERY` | WASTE | ≥ 2 ads ativos no **mesmo ad set** com o **mesmo `contentHash`**, ambos com `spend ≥ p_min` — **escopo AD_SET** | `spend` do pior | gasto diário do pior | ≥ 2 ads com gasto relevante | SETTLING | `CONSOLIDATE_OVERLAP` |
| `BUDGET_STARVATION` | **OPPORTUNITY** | `aiScore ≥ t` e `impressions < p10 do adset` | — (não é gasto) | ganho potencial diário | score presente, pares ≥ 3 | SETTLING | `SCALE_WINNING_AD` |

**Nenhum tipo fica órfão.** `EXPAND_AUDIENCE` é a primeira recomendação **consultiva**: expandir
público está fora do escopo permanente da Allva, então ela carrega `advisory: true`, `actions: []` e
`outOfScopeReason`. Diz o que fazer na plataforma em vez de fingir uma ação ou esconder o
diagnóstico. Recomendações consultivas nunca entram nas métricas de acurácia de P8.

**Dois detectores foram redefinidos para o que é computável na v2.0.**

`AUDIENCE_SATURATION` não pode exigir "alcance estagnado em 7 dias": **reach diário não é somável em
reach semanal** — alcance é contagem de pessoas distintas, e somar sete dias conta a mesma pessoa
sete vezes. Obter reach deduplicado de 7 dias exige uma chamada de insights adicional por ad set, o
que muda o orçamento de R4. A v2.0 usa tendência de frequência com impressões estáveis como proxy;
onde `PlatformProfile.metrics.unavailable.frequency` está declarado (Search no Google), o detector
não roda. A chegada do reach dedup é mudança de **lógica**, logo `SUPERSEDED_BY_DETECTOR`.

`OVERLAPPING_DELIVERY` não pode exigir "público sobreposto": sobreposição real entre ad sets não é
computável com o que o sync coleta, e **dentro** do mesmo ad set é tautológica — o público é o mesmo
por definição. O que é observável e acionável é conteúdo idêntico competindo no mesmo leilão, que é a
causa concreta do desperdício. Sobreposição real entre conjuntos e canibalização já estão no
Horizonte 2 (§20), como análise de portfólio.

## 10.6 Somabilidade

| Grandeza | Regra |
|---|---|
| `incurredAmount` entre tipos, no mesmo anúncio | **não soma** — o mesmo gasto seria contado duas vezes. O total do anúncio é o `max` |
| `incurredAmount` entre anúncios | **soma** — valores disjuntos por construção |
| `avoidableDailyAmount` entre tipos, no mesmo anúncio | **não soma** — o `max`, pois pausar resolve tudo de uma vez |
| Qualquer grandeza com `findingKind = OPPORTUNITY` | **nunca entra** em total de desperdício |
| Itens com `windowDays` divergente | **excluídos** do agregado e contados à parte |

`Ad.openWasteAmountBase` guarda o `max` de `incurredAmountBase`; `Ad.avoidableDailyAmountBase`, o
`max` de `avoidableDailyBase`. São essas colunas — e somente elas — que os rollups somam.

## 10.7 Fluxo de detecção

```text
DetectWasteUseCase(adAccountId, windowDays, profileVersion)

 1. GUARDA: a conta teve sync bem-sucedido e completo nesta janela?
            não ⇒ encerra sem detectar E SEM RESOLVER NADA
 2. carrega ads ativos + snapshots agregados por ad, em moeda-base (M1)
 3. calcula baselines por ad set (mediana, p10, p25, p50, p75) e da conta
 4. AD-SCOPED: por ad, roda os detectores cuja evidência mínima e maturidade são atendidas
 5. ADSET-SCOPED: por conjunto, roda os relacionais; atribui pela regra determinística
 6. upsert por fingerprint = sha256(adId | type)
       existe aberto → occurrences++ SE lastSeenAt for de janela anterior
                       atualiza incurred, avoidableDaily, evidence
       não existe    → cria OPEN
 7. AUTO-RESOLVE — somente para achados cujo ad teve observação válida:
       condição cessou              → RESOLVED_EXTERNALLY
       ad arquivado (sync completo) → STALE
       dado re-declarado desfez     → RESOLVED_BY_RESTATEMENT  ← falso positivo
       sem observação válida        → permanece OPEN, staleObservation = true
 8. atualiza as denormalizações do Ad
 9. emite waste.detected com adId, wasteItemId, type, kind, amounts, currency, priority
```

Os passos 1 e 7 são a mesma ideia aplicada duas vezes: **ausência de dado nunca é evidência**. Sem
eles, uma integração fora do ar por uma noite resolve todo o desperdício aberto da organização como
"condição cessou".

## 10.8 Rollups como read models

```sql
-- GET /waste/rollup?groupBy=campaign
-- O ad é agregado ANTES de subir para a campanha. Sem a subconsulta, o JOIN 1:N
-- multiplica a linha do ad e o SUM da coluna do lado 1 conta o mesmo valor N vezes.
SELECT c.id, c.name,
       COUNT(*)                    AS affected_ads,
       SUM(x.open_waste_base)      AS open_waste_base,      -- máximo por anúncio
       SUM(x.avoidable_daily_base) AS avoidable_daily_base, -- o número acionável
       SUM(x.critical_items)       AS critical_items
  FROM (
    SELECT a.id, a.campaign_id,
           a.open_waste_amount_base      AS open_waste_base,
           a.avoidable_daily_amount_base AS avoidable_daily_base,
           COUNT(*) FILTER (WHERE w.priority IN ('HIGH','CRITICAL')) AS critical_items
      FROM ads a
      JOIN open_waste w ON w.ad_id = a.id     -- view: só finding_kind = 'WASTE'
     WHERE a.organization_id = $1
       AND a.archived_at IS NULL
     GROUP BY a.id                            -- ← cada ad contribui exatamente uma linha
  ) x
  JOIN campaigns c ON c.id = x.campaign_id
 GROUP BY c.id, c.name
 ORDER BY avoidable_daily_base DESC;
```

Soma `ads.open_waste_amount_base` — o máximo por anúncio — e **não** `waste_items.amount`, que
somaria entre tipos e recriaria a dupla contagem no eixo tipo. Passa pela view, que exclui
oportunidades. Ordena pelo que dá para agir.

> **A subconsulta não é otimização, é correção.** Somar uma coluna do lado 1 de um join 1:N a
> multiplica pela cardinalidade do lado N: um anúncio com três achados abertos entraria três vezes no
> número de capa. É o Apêndice A nº 2 — a dupla contagem que motivou toda a v2.0 — reaparecendo no
> eixo do achado em vez de no eixo do nível. **Teste dedicado, obrigatório:** um ad com 3 achados
> abertos contribui uma vez para o rollup.
>
> **A janela não filtra o join.** A denormalização em `ads` é sempre da janela ativa da organização
> (`OrganizationAdsSettings.scoringWindowDays`), e não tem dimensão de janela; filtrar o join por
> `w.window_days` enquanto se soma uma coluna sem janela é incoerente. A janela vigente é declarada
> em `meta.provenance.windowDays`, e itens remanescentes de uma janela anterior — legado de troca de
> configuração — ficam fora e são reportados em `meta.excludedByWindowMismatch`, como §10.6 já manda.

Nenhuma linha de desperdício agregada é armazenada. O contexto é sempre derivado.

**As denormalizações são cache, e cache diverge.** O job `denormalization-reconcile` (§8.8) compara
diariamente `ads.open_waste_amount_base` com `MAX(incurred_amount_base)` da view, **corrige** a
divergência — a agregação é a verdade — e emite `DENORMALIZATION_DRIFT`. Divergência recorrente é bug
do worker (§5.4, regra 2), não ruído.

## 10.9 Resolução

| Caminho | Endpoint | Efeito |
|---|---|---|
| Manual | `PATCH /waste/items/{id}/resolve` | `RESOLVED_EXTERNALLY` ou `DISMISSED`, com motivo |
| Por ação | `POST /waste/items/{id}/apply-fix` | executa a recomendação e resolve **todos** os itens ligados a ela |
| Por anúncio | `POST /ads/{id}/resolve` | resolve os abertos do ad (`?types=`) |
| Automático | worker | `RESOLVED_EXTERNALLY` · `STALE` · `RESOLVED_BY_RESTATEMENT` |
| Por versão | worker | `SUPERSEDED_BY_DETECTOR` — só em mudança de lógica |

A relação `Recommendation` ↔ `WasteItem` é **N:N**. Um plano coerente responde a vários sinais do
mesmo anúncio, e aplicá-lo resolve todos os itens que o originaram.

---

# 11. Creative Lab

## 11.1 Reposicionamento

Deixa de pontuar criativos — isso é `ad-scoring` — e passa a fazer três coisas:

1. **explicar** por que o criativo funciona ou não, no contexto de cada anúncio que o veicula;
2. **comparar** o mesmo criativo entre anúncios, discriminando criativo ruim de público errado;
3. **propor substituições** — sugestões de texto e **candidatos concretos** de criativo.

## 11.2 Análise por par `(Creative, Ad)`

O criativo é analisado no contexto do anúncio que o veicula. Um mesmo criativo em dois anúncios rende
duas análises, com diagnósticos que podem divergir legitimamente: *"neste ad set o hook funciona;
naquele, não"*.

Um criativo em 5 anúncios tem 5 desempenhos; um score único derivado da soma não descreve nenhum —
e a ação que ele sugere ("refrescar criativo") pode ser errada, porque o problema é o público de um
anúncio, não o criativo.

## 11.3 Comparação entre anúncios do mesmo criativo

```
GET /creatives/{id}/ads
→ ads: [ { ad, aiScore, confidence, componentCoverage, roas, adSet }, … ]
  dispersion: { measure: "IQR", value: 31, sampleSize: 5 }
  verdict:    { value: "AUDIENCE_MISMATCH", confidence: 0.62,
                alternativeExplanations: ["orçamentos díspares entre ad sets",
                                          "tempo em veiculação desigual"] }
```

| Regra | Razão |
|---|---|
| Dispersão por **IQR ou MAD**, nunca `max − min` | um outlier não pode definir o diagnóstico |
| Mínimo de **3 anúncios** com evidência suficiente | diferença entre dois pontos não é dispersão |
| Só compara scores com **cobertura de componentes compatível** | comparar 5 componentes com 2 produz dispersão artificial |
| Veredito com `confidence` e `alternativeExplanations[]` | público é uma hipótese entre lance, orçamento, posicionamento e tempo em veiculação (P7) |
| Abaixo do mínimo | **sem veredito** — a comparação é exibida sem conclusão |

A leitura: dispersão baixa com score baixo indica criativo ruim (`REFRESH_FATIGUED_CREATIVE`);
dispersão alta indica criativo bom com público errado em um dos anúncios (`PAUSE_AD` naquele).

## 11.4 Candidatos de substituição

`REPLACE_CREATIVE` recebe `creativeId` — um criativo **existente**. É a ação principal de
`REFRESH_FATIGUED_CREATIVE`, e sem uma fonte definida ela seria uma ação com parâmetro inexistente.

```text
CreativeCandidateResolver(adId, fatiguedCreativeId)
  1. candidatos = criativos da mesma conta com score alto nos anúncios em que rodaram
  2. exclui os que já rodaram neste ad set nos últimos N dias
  3. ranqueia por: score do candidato · DISSIMILARIDADE de contentHash em relação ao fatigado
  4. devolve top-K com justificativa por candidato
```

**A dissimilaridade é o ponto.** Trocar um criativo cansado por outro quase idêntico resolve o
registro, não o problema.

**A origem é fechada:** criativos já veiculados na conta. Geração pela Allva é proibida (P1), e a
superfície de upload está fora do escopo da v2.0 (D7.1). Quando não há candidato disponível,
`REFRESH_FATIGUED_CREATIVE` vira **consultiva**: *"este criativo se esgotou e não há substituto na
conta; suba um criativo novo na plataforma"*.

`REPLACE_COPY` e `REPLACE_CTA` seguem outro caminho — seus parâmetros vêm das sugestões de texto.

## 11.5 Pipeline

```text
AnalyzeAdCreativeUseCase(adId, trigger)
  1. carrega Ad + Creative + AdScore corrente (versão ativa da organização)
  2. version = último + 1 para (creativeId, adId)
  3. digest = hash(métricas da janela + Creative.contentHash)
     igual ao da última versão e trigger = SCHEDULED ⇒ pula
  4. diagnósticos determinísticos a partir dos componentes do AdScore
  5. sugestões por regra (hook / body / CTA / formato), condicionadas ao componente fraco
  6. candidatos de substituição via CreativeCandidateResolver
  7. enriquecimento IA opcional (P4): sobrepõe apenas SUGESTÕES, nunca diagnósticos,
     marcando aiAuthored = true + aiProvider + aiModel
  8. persiste CreativeAnalysis(COMPLETED, adScoreId, engineVersion)
```

**Conteúdo autoral de IA que vai ao ar exige tratamento próprio.** As sugestões viram os parâmetros
`title`, `body` e `callToAction` de `REPLACE_COPY` e `REPLACE_CTA`: é texto escrito por LLM
publicado como anúncio, sob a marca do cliente.

| Regra | |
|---|---|
| Parâmetro originado de IA carrega `aiAuthored: true` + provider + modelo | rastreabilidade |
| A aplicação exige **confirmação explícita do texto final**, nunca em lote | é conteúdo de marca |
| Nunca automatizável, mesmo em v2.2 | fora do escopo de automação supervisionada |
| O texto aplicado é registrado em auditoria como conteúdo publicado | responsabilidade |

E o aviso de `requiresRecreate` é obrigatório: no Meta, trocar copy recria o anúncio, reinicia o
aprendizado e zera a prova social.

## 11.6 Escopo e preservação

**D7.1 — a superfície de pré-veiculação fica fora da v2.0.** `POST /creatives/upload` e o fluxo de
análise pré-veiculação não são construídos. A tabela `CreativeUpload` permanece no schema —
uma tabela vazia custa nada e mantém a porta aberta.

Razão: um criativo que não está veiculando não tem gasto, não tem métrica, não tem desperdício. A
análise dele é puramente preditiva — a mesma classe de feature do simulador pré-voo que D1 remove.

**O pipeline ffmpeg** (`VIDEO_PREVIEW_ENABLED`) migra para cá e permanece: serve o domínio real,
gerando thumbnail de criativo **sincronizado** que veio sem `thumbnailUrl` da plataforma.

**Todas as calculadoras puras** de `creative-lab/domain/scoring/` são preservadas integralmente e
movidas para `ad-scoring/domain/scoring/`. Mudam de endereço e de entrada — não de lógica.

---

# 12. AI Score

## 12.1 Estrutura

```text
AI Score (composto, 0..100, por Ad, por janela, por algoVersion)
    │
    ├── Attention              nativo 0..100  ↑     peso 0,25
    ├── Audience Fit           nativo 0..100  ↑     peso 0,30
    ├── Learning Stability     nativo 0..100  ↑     peso 0,15
    ├── Negative Feedback Risk nativo 0..100  ↓     peso 0,15   (invertido)
    └── Fatigue                nativo 0..1    ↓     peso 0,15   (invertido)

Contexto declarado, FORA do composto:
    └── Saturation Risk        nativo 0..1    ↓     scopeLevel: AD_SET

Cada componente persiste: value (nativo) · normalizedValue (0..100, ↑) ·
                          confidence (0..1) · available · reasons[] · inputs
```

**Duas grandezas por componente.** `value` é a escala nativa da calculadora — é o que os detectores
consomem (`fatigueScore ≥ 0.65` permanece válido). `normalizedValue` é a escala canônica `0..100`
com "maior é melhor" — é o que o composto consome. A função de normalização é pura, versionada com
`algoVersion` e testada nas fronteiras. Sem essa separação, o composto não é recalculável a partir
da linha persistida, e P7 fica sem lastro.

**`Saturation Risk` é contexto, não componente.** Propriedade do ad set imputada ao anúncio (P2,
corolário relacional). Permanece útil como guarda de `SCALE_WINNING_AD`, mas nunca entra no número
que o produto chama de AI Score.

## 12.2 Sinais, disponibilidade e dívida

| Score | Pergunta | Sinais | Disponibilidade |
|---|---|---|---|
| **Attention** | prende nos primeiros segundos? | thumbstopRate, holdRate, CTR vs. pares | **vídeo, e só onde a plataforma expõe** |
| **Audience Fit** | entrega a quem converte? | CPA/ROAS vs. pares do ad set, taxa de conversão | universal |
| **Negative Feedback Risk** | vai gerar rejeição? | hides, hideAllFor, reports, unlikes | **onde a plataforma expõe** |
| **Learning Stability** | o aprendizado estabilizou? | variância dia a dia de CPA/CTR, volume | universal |
| **Fatigue** | o criativo se esgotou? | frequência ↑ + CTR ↓ + CPA ↑ ao longo do tempo | requer `frequency` |

**Três grandezas, não uma.** Cobertura absoluta e cobertura relativa respondem perguntas diferentes,
e fundi-las apaga plataformas inteiras do produto.

```
componentCoverage   = Σ wᵢ (componentes disponíveis)      / Σ wᵢ (todos)
platformCoverageMax = Σ wᵢ (mensuráveis NESTA plataforma) / Σ wᵢ (todos)   ← do PlatformProfile
coverageRatio       = componentCoverage / platformCoverageMax
```

| Grandeza | Responde | Uso |
|---|---|---|
| `componentCoverage` | "quanto do modelo este score cobre?" | **exibido** — é a honestidade absoluta |
| `platformCoverageMax` | "quanto do modelo esta plataforma permite cobrir?" | declarado no perfil |
| `coverageRatio` | "este score é o melhor que esta plataforma permite?" | **os pisos de §12.4 incidem aqui** |

`AdScore` persiste `componentsAvailable`, `componentsUnavailable` (motivo vindo de
`PlatformProfile.metrics.unavailable`) e as três grandezas. **Abaixo do limiar, o composto não é
publicado como score comparável** — os componentes disponíveis continuam sendo exibidos, com o que
falta declarado.

**Por que o piso não pode ser absoluto.** `Attention` — o segundo maior peso — depende de métricas de
vídeo e não existe para anúncio estático nem para Search no Google. Um Search sem `attention` (0,25),
sem `negativeFeedbackRisk` (0,15) e sem `frequency`→`fatigue` (0,15) tem `componentCoverage = 0,45`,
abaixo do piso de 0,60 que §12.4 exige para **toda ordenação e todo alerta**. Com piso absoluto, um
produto que se define como multi-plataforma some da tela que o define — e não por bug, mas por
consequência lógica das regras.

Com `coverageRatio`, o mesmo anúncio com os três componentes que a plataforma expõe marca `1,0` e
**entra** na ordenação; o mesmo anúncio sem dados suficientes para `audienceFit` cai e sai, que é o
comportamento correto.

**A comparabilidade é preservada por declaração, não por exclusão.** `GET /ads` expõe
`meta.coverageByPlatform`, e `AdListItemView` carrega `aiScore`, `confidence` e `coverageRatio`
**juntos** — sem isso, um score 50 por ignorância (prior dominante, cobertura baixa) e um 50 por
mediocridade apareceriam idênticos na lista.

> **Dívida declarada.** Até A2-S4 coletar `hides`, `hideAllFor`, `reports` e `unlikes`,
> `NegativeFeedbackRisk` opera sobre proxies. Isso não é baixa confiança — é **outra medida**. O
> componente é marcado `proxyBased: true`, e a chegada dos sinais reais gera `seriesDiscontinuity`.

## 12.3 Composição

```typescript
const WEIGHTS = {
  attention: 0.25, audienceFit: 0.30, learningStability: 0.15,
  negativeFeedbackRisk: 0.15, fatigue: 0.15,
} as const;

const NEUTRAL_PRIOR = 50;
const PRIOR_WEIGHT  = k;        // versionado em algoVersion

aiScore      = (Σ wᵢ·cᵢ·normalizedᵢ + k·NEUTRAL_PRIOR) / (Σ wᵢ·cᵢ + k)
aiConfidence = Σ (wᵢ·cᵢ) / Σ wᵢ        // sobre TODOS os pesos, não só os disponíveis
```

**O termo do prior é o que faz a ponderação por confiança funcionar.** Uma média ponderada pura
auto-normaliza pelo denominador: um anúncio de 3 dias cuja única componente mensurável é fadiga
receberia o valor da fadiga como AI Score — tão assertivo quanto o de um anúncio com 30 dias e cinco
componentes, apenas com um rótulo de confiança baixa ao lado.

Com o prior, evidência fraca puxa o score para o neutro. *"Ainda não sei"* tem um lugar na escala, e
esse lugar é o meio.

`aiConfidence` divide pela soma de **todos** os pesos — assim um componente ausente reduz a confiança
em vez de desaparecer da conta.

## 12.4 Consumo: confiança mínima declarada

Um mecanismo de confiança que nenhum consumidor consulta não protege nada.

Os pisos de cobertura incidem sobre **`coverageRatio`**, nunca sobre `componentCoverage`.

| Consumidor | Confiança mínima | `coverageRatio` mínimo | Abaixo disso |
|---|---|---|---|
| Exibição no detalhe | — | — | mostra com `INSUFFICIENT_EVIDENCE` |
| `?scoreBelow=` · `sortBy=aiScore` | 0,40 | 0,60 | não entra na ordenação |
| `sortBy=scoreDelta` · `?scoreDroppedBy=` | 0,50 | 0,60 | não entra |
| Alerta `AD_SCORE_DROPPED` | 0,60 | 0,60 | não alerta |
| Detectores que consomem componentes | por componente | — | componente indisponível ⇒ detector devolve `null` |
| Guarda de `SCALE_WINNING_AD` | **0,70** | 0,80 | não recomenda escalar |

O piso mais alto é o da única ação que **aumenta** gasto.

`Ad.currentScoreConfidence` e `Ad.currentScoreCoverage` são denormalizados justamente para que estes
pisos sejam aplicáveis em `WHERE`, sem join na série — é o que sustenta o p95 < 400 ms de §17.2.

## 12.5 Persistência, versionamento e descontinuidade

Série append-only. `Ad.currentAiScore`, `currentScoreConfidence` e `scoreDelta7d` são
denormalizações de leitura por valor; toda leitura de série filtra pela **versão ativa da
organização**. Versões em sombra gravam e são comparadas offline, nunca aparecem no produto.

**Scoring roda apenas para anúncios ativos com dados na janela.** Anúncio pausado ou arquivado tem o
último score preservado com `frozenAt`; nenhum alerta de queda é gerado sobre ele.

**Descontinuidade de série.** Certas mudanças quebram a comparabilidade sem que nada tenha
acontecido com o anúncio:

| Motivo (`seriesDiscontinuity`) | Exemplo |
|---|---|
| `NEW_SIGNAL` | `hides`/`reports` chegando em A2-S4 muda o que `NegativeFeedbackRisk` mede |
| `ATTRIBUTION_WINDOW_CHANGED` | reconfiguração da conta na plataforma |
| `RESUMED_AFTER_PAUSE` | anúncio retomado após intervalo sem dados |
| `ALGO_VERSION_CHANGED` | nova `algoVersion` vigente para a organização |
| `CURRENCY_REBASED` | troca de moeda-base (§4.1): toda a série monetária muda de unidade |

O campo é `String?` — o **motivo**, não um booleano — em `AdScore` **e** em `AdMetricSnapshot`. Dois
tipos para o mesmo conceito obrigariam cada consumidor a traduzir entre eles, e a tradução é onde a
causa se perde.

**Delta, tendência e alertas não atravessam uma descontinuidade.** Sem isso, o dia do deploy dos
sinais de feedback negativo produz um salto de score em todo anúncio ativo, e o produto reporta em
massa quedas e altas que são artefato de release.

## 12.6 Papel da IA (P4)

| Etapa | Responsável | Falha de IA implica |
|---|---|---|
| Coleta de sinais | sync | — |
| Cálculo dos componentes | determinístico puro | — |
| Normalização e composição | determinístico puro | — |
| `reasons[]` por componente | determinístico (templates) | — |
| `aiNarrative` | LLM via módulo `ai` | campo `null`, resto intacto |
| Sugestões criativas | LLM com fallback por regra | fallback determinístico |

> **O nome "AI Score" descreve o produto, não o método.** O número é determinístico e auditável; a
> IA explica. Um score que varia entre execuções por causa de temperatura de LLM não pode ancorar
> uma decisão de pausar mídia paga.

---

# 13. Platform Actions

## 13.1 Catálogo

**Ad Actions:**

| Ação | Parâmetros | Reversível | Meta | Google | TikTok |
|---|---|---|---|---|---|
| `PAUSE_AD` | — | sim | ✔ | ✔ | ✔ |
| `ENABLE_AD` | — | sim | ✔ | ✔ | ✔ |
| `ARCHIVE_AD` | — | não | ✔ | ✔ (REMOVED) | ✔ |
| `DUPLICATE_AD` | `targetAdSetId?` | n/a | ✔ | ✔ | ✔ |
| `REPLACE_CREATIVE` | `creativeId` | sim | ✔ | ⚠ recria | ⚠ recria |
| `REPLACE_COPY` | `title?`, `body?` | sim | ⚠ recria | ✔ | ⚠ recria |
| `REPLACE_CTA` | `callToAction` | sim | ⚠ recria | ✔ | ⚠ recria |

**AdSet Actions** — só quando o efeito não é alcançável no anúncio: `PAUSE_AD_SET`, `ENABLE_AD_SET`,
`ADJUST_AD_SET_BUDGET` (orçamento não existe no nível do anúncio).

**Campaign Actions** — apenas quando a plataforma exige: `PAUSE_CAMPAIGN`, `ENABLE_CAMPAIGN`,
`ADJUST_CAMPAIGN_BUDGET` (**CBO ativo** — o orçamento vive na campanha). Campanha é exceção
justificada por restrição de plataforma, nunca alvo padrão, e sempre com `scopeWarning`.

## 13.2 Contrato do gateway

```typescript
export interface AdActionGateway {
  readonly platform: Platform;
  capabilities(): AdActionCapability[];
  validate(cmd: AdActionCommand): Promise<ValidationResult>;
  execute(cmd: AdActionCommand, ctx: ExecutionContext): Promise<AdActionResult>;
  revert(cmd: AdActionCommand, previousState: unknown, ctx: ExecutionContext): Promise<AdActionResult>;
}

export type AdActionCapability = {
  type: AdActionType;
  supported: boolean;
  reversible: boolean;
  requiresRecreate: boolean;                     // a plataforma não edita, recria
  createsEntity: boolean;                        // P1 — derivação declarada
  validationDepth: 'PLATFORM' | 'LOCAL_ONLY';
  constraints?: Record<string, unknown>;
  unsupportedReason?: string;
};

export type AdActionResult = {
  status: 'SUCCEEDED' | 'FAILED' | 'REJECTED_BY_PLATFORM' | 'UNSUPPORTED';
  platformEntityId?: string;   // novo id quando a ação recria — PERSISTIDO em ActionExecution
  raw?: unknown;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
};
```

**`validationDepth` dá lastro ao dry-run.** Validação local pega parâmetro faltante, tipo errado e
moeda incorreta (M3). Só a validação da plataforma pega "este ad set está sob CBO e não aceita
orçamento próprio", "este anúncio está em revisão", "este criativo foi removido". Um dry-run local
aprovando um lote de 100 anúncios aprova exatamente as operações que a plataforma vai rejeitar.

## 13.3 Capability registry

`ActionCapabilityRegistry` agrega as capabilities e responde `GET /ads/{id}/actions/available`. Uma
ação nunca é oferecida se a plataforma não a suporta, e o motivo é explícito (P6).

`requiresRecreate` é semanticamente relevante para o produto: em Meta, trocar a copy **cria um
anúncio novo e arquiva o antigo**, reiniciando o aprendizado e zerando o histórico social. O usuário
precisa saber antes de confirmar, e o `AdAction` carrega esse aviso em `estimatedEffect`.

## 13.4 Execução

```text
worker action-execution
  1. carrega ActionExecution + AdAction + Ad + credencial via AdAccount
  2. refresh de token se necessário
  3. dryRun → validate(), grava resultado com validationDepth, encerra
  4. gateway.execute(cmd, { idempotencyKey })
  5. mapeia resultado:
        SUCCEEDED            → persiste resultPlatformEntityId, mantém PENDING_WRITE,
                               agenda escada de verificação
        REJECTED_BY_PLATFORM → FAILED, reverte desiredStatus, libera I2, Alert(ACTION_FAILED)
        retryable            → backoff exponencial com jitter, máx. 3 tentativas
  6. audit: ad.action.executed | ad.action.failed, com origin
  7. emite action.executed
```

A política de retry reaproveita a infraestrutura madura de classificação de erro (status HTTP,
`Retry-After`, cooldown, backoff com jitter), generalizada em `platform-clients`.

## 13.5 Segurança (P5)

| Controle | Regra |
|---|---|
| **Autorização** | `PAUSE`/`ENABLE`: papel ≥ `ANALYST`. `ARCHIVE`/`REPLACE_*`/budget: ≥ `ADMIN` |
| **Kill switch** | `Organization.actionsEnabled` — desliga toda escrita da org instantaneamente |
| **Consentimento** | primeira ação de uma integração exige `IntegrationWriteConsent`, com conta, timestamp e tipos consentidos |
| **Revalidação** | toda aplicação revalida a premissa contra dados frescos antes de escrever |
| **Concorrência por alvo** | no máximo uma escrita em voo por `(entityType, entityId)` — I2 |
| **Conflito** | ações opostas sobre o mesmo alvo não coexistem como aplicáveis |
| **Escala** | ações que **aumentam** gasto exigem as seis guardas de §9.3 |
| **Rate limit** | por integração e por organização; teto diário configurável |
| **Blast radius** | lote máx. 100; ações em `CAMPAIGN` exigem confirmação com escopo explícito |
| **Idempotência** | `Idempotency-Key` do cliente; replay devolve o resultado original |
| **Reversibilidade** | `previousState` capturado antes; reversão é **ação própria**, auditada |
| **Auditoria** | toda execução gera `AuditLog` **e** `SecurityAuditLog` |
| **Dry-run** | disponível para toda ação; em lote > 10, exige `validationDepth: PLATFORM` |
| **Conteúdo de IA** | parâmetro `aiAuthored` exige confirmação explícita do texto; nunca em lote |

---

# 14. Banco de dados e migração

## 14.1 Estratégia — reconstrução do domínio de mídia

**Premissa (D9.1):** não há dado relevante no domínio de mídia e inteligência. Isso substitui o plano
de três fases (Expand → Migrate → Contract) por uma **migração destrutiva única**, executada antes de
qualquer onboarding real.

> **Premissa confirmada em 2026-07-30:** nenhuma organização real conectou conta de anúncios — nem em
> produção, nem em desenvolvimento. A migração destrutiva está autorizada.
>
> **A confirmação tem validade, não é permanente.** Ela deixa de valer no instante em que a primeira
> conta real for conectada. Se A2-S1 não tiver rodado até lá, a estratégia muda — reconfirmar antes
> de executar a migração, não antes de planejá-la.

```
migração 20260801000000_ads_first_v2
  ├── DROP   domínio de mídia: campaigns (local), campaign_analyses, creative_assets,
  │          external_*, metric_snapshots, waste_items, recommendations,
  │          creative_optimizations, ad_accounts
  ├── DROP   enums órfãos: MetricLevel, CampaignStatus, CampaignAnalysisStatus,
  │          AdObjective, AdFormat, CreativeType
  ├── CREATE schema v2.0 completo, com todas as constraints já corretas
  ├── CREATE índices, índices parciais e a view open_waste
  └── PRESERVA accounts, organizations, billing, auditoria e integrations
```

**Zona preservada:** `accounts`, `auth`, `organizations`, `memberships`, `invitations`, `plans`,
`subscriptions`, `invoices`, `billing`, `audit_logs`, `security_audit_logs`, `sales_leads`,
`contacts`, `notifications`, `preferences` — dado real.

**`integrations` é preservada por atrito.** Os dados de mídia são descartáveis; os **tokens OAuth
não**. Dropá-los faria todo usuário reconectar — fricção desnecessária, já que sob P10 a
`Integration` deixa de ser pai identitário e vira apenas credencial. As `ad_accounts` são
redescobertas pelo primeiro sync, com identidade correta.

> **A premissa tem prazo de validade.** A janela fecha quando a primeira organização real conectar
> uma conta de anúncios real em produção. A partir daí existe histórico de score, série de métrica e
> linhagem que o produto promete não perder, e o plano de três fases volta a ser necessário. **A
> reconstrução acontece antes de qualquer onboarding real** — restrição de cronograma, não técnica.

## 14.2 O schema nasce correto

| Decisão | Origem |
|---|---|
| Uniques por `ad_account_id`, nunca por `integration_id` | P10 |
| `ad_accounts` única por `(organization_id, platform, external_account_id)` | P10 |
| `organization_id NOT NULL` em toda tabela de inteligência e de contexto | D3.1 |
| `ad_id NOT NULL` em waste, recomendação, score, snapshot, análise | P2 |
| `lineage_id NOT NULL`, default = próprio `id` | §3.6 |
| Colunas monetárias em par: original + `*Base` + `fx_rate` + `fx_as_of` + `fx_source` | D3.2 |
| `finding_kind` separando `WASTE` de `OPPORTUNITY` | §10.2 |
| `incurred_amount` e `avoidable_daily_amount` como grandezas distintas | §10.1 |
| `origin` em `ad_actions`; `target_entity_*` para I2 | P3, I2 |
| `result_platform_entity_id` em `action_executions` | §9.5 |
| Componentes de `ad_scores` com `value`, `normalized_value`, `available`, `confidence` | §12.1 |
| `series_discontinuity` em `ad_scores` e `ad_metric_snapshots` | §12.5 |
| Sem `subject_type`/`subject_id`; sem `reference_type`/`reference_id` — FKs tipadas com `CHECK` | §4.7 |
| Sem `MetricLevel`: uma granularidade só | §4.4 |
| Nomes finais desde o início | — |
| `CHECK` de coerência entre `status` e `resolved_at` em `waste_items` | §4.5 |
| `idempotency_key` única por `(organization_id, key)`, nunca global | §4.6 |
| Seis FKs tipadas em `alerts`, com `CHECK` de exclusividade | §4.7 |
| `job_runs` com `lease_expires_at` e `attempt` | §4.7 |
| `ad_accounts` com `sync_health` e `restatement_window_days` | §4.1 |
| `recommendation_outcomes` com `post*` nullable e `measurement_version` | §4.5 |

### 14.2.1 O que nasce certo e o que pode mudar depois

A migração congela em A2-S1 um schema cujas partes só serão exercitadas em S5–S7. Isso é aceitável
**se e somente se** a fronteira estiver declarada:

| Irreversível — nasce certo em S1 | Aditivo — muda sem migração destrutiva |
|---|---|
| particionamento de `ad_metric_snapshots` | estrutura interna dos campos `Json` |
| uniques, `NOT NULL`, FKs, `CHECK`s | colunas novas nullable |
| os 4 índices parciais e a view `open_waste` | índices novos |
| nomes finais de tabela e coluna | valores novos em enum |

Todo campo `Json` — `AdScore.components`, `DetectorProfile.thresholds`, `AdAction.parameters`,
`WasteItem.evidence`, `Recommendation.impacts` — carrega `schemaVersion` no próprio payload e é
validado por **schema Zod versionado** no `domain/` desde S1. Mudança de forma é bump de versão mais
migrador de leitura, não migração de banco. Sem essa disciplina, "o schema nasce correto" seria uma
aposta sobre decisões que ainda não foram tomadas.

## 14.3 `ad_metric_snapshots` nasce particionada

```sql
CREATE TABLE ad_metric_snapshots ( … ) PARTITION BY RANGE (date);

CREATE TABLE ad_metric_snapshots_2026_08 PARTITION OF ad_metric_snapshots
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Rede de segurança: sem ela, o primeiro ingest depois da última partição morre com
-- "no partition of relation found" e a organização perde a ingestão inteira.
-- Deve estar sempre VAZIA; linha aqui é alerta operacional, não caminho normal.
CREATE TABLE ad_metric_snapshots_default PARTITION OF ad_metric_snapshots DEFAULT;
```

**Partições futuras não se criam sozinhas.** G4 exige ≥ 3 meses à frente, e o Prisma não gerencia
partições: o job `metrics-partition-maintenance` (§8.8) cria as dos próximos 3 meses todo mês e
emite `PARTITION_MARGIN_LOW` se a margem cair abaixo de 60 dias.

É a tabela de maior volume e a base de todo rollup, baseline e score. Na escala da **plataforma** —
não de uma organização — são ~180M linhas/ano, com a janela de re-declaração de 14 dias reescrevendo
a partição corrente a cada ingest.

Nascer particionada é gratuito; converter depois não é. Ganhos imediatos: retenção vira
`DROP PARTITION`; autovacuum trabalha por partição; índices de série menores e mais quentes em cache.

## 14.4 Índices

Criados com as tabelas vazias — sem `CONCURRENTLY`, sem janela, sem risco.

```sql
-- tela principal — a coluna id ao final sustenta o cursor
CREATE INDEX ON ads (organization_id, current_ai_score, id);
CREATE INDEX ON ads (organization_id, score_delta_7d, id);
CREATE INDEX ON ads (organization_id, avoidable_daily_amount_base DESC, id);
CREATE INDEX ON ads (organization_id, sync_state);
CREATE INDEX ON ads (organization_id, campaign_id);
CREATE INDEX ON ads (lineage_id);
CREATE INDEX ON ads (ad_account_id, archived_at);

-- séries
CREATE INDEX ON ad_metric_snapshots (ad_id, date DESC);
CREATE INDEX ON ad_metric_snapshots (organization_id, date);
CREATE INDEX ON ad_scores (ad_id, score_date DESC);
CREATE INDEX ON ad_scores (organization_id, algo_version, score_date);

-- inteligência e ações
CREATE INDEX ON waste_items (organization_id, finding_kind, status, priority, id);
CREATE INDEX ON waste_items (ad_id, status);
CREATE INDEX ON action_executions (result_platform_entity_id);
CREATE INDEX ON recommendation_outcomes (lineage_id);
CREATE INDEX ON fx_rates (from_currency, to_currency, date);

-- índices parciais: as invariantes que o Prisma não declara
CREATE UNIQUE INDEX waste_items_open_unique
  ON waste_items (fingerprint) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX creative_analyses_version_unique
  ON creative_analyses (creative_id, ad_id, version) WHERE ad_id IS NOT NULL;
CREATE UNIQUE INDEX recommendations_active_unique
  ON recommendations (ad_id, kind) WHERE status IN ('NEW','ACKNOWLEDGED','APPLYING');
CREATE UNIQUE INDEX action_executions_inflight_unique
  ON action_executions (target_entity_type, target_entity_id)
  WHERE status IN ('QUEUED','RUNNING');
CREATE UNIQUE INDEX alerts_open_unique
  ON alerts (fingerprint) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX sync_quarantine_open_unique
  ON sync_quarantine (ad_account_id, external_ad_id) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX currency_migrations_active_unique
  ON currency_migrations (organization_id) WHERE status IN ('PENDING','RUNNING');
```

Os **sete** índices parciais não são otimização — são as invariantes I2, dedupe de waste,
versionamento de análise, plano ativo, dedupe de alerta, reentrada em quarentena e recomputo único de
moeda. A ausência de qualquer um é bug de correção, não de desempenho.

Os três últimos foram acrescentados na revisão de implementação: nos três casos, uma unique **total**
teria o efeito oposto ao pretendido — impediria o mesmo alerta de reabrir, o mesmo ad de voltar à
quarentena e a mesma organização de trocar de moeda duas vezes.

## 14.5 Gates

| Gate | Verificação | Esperado |
|---|---|---|
| G1 | Nenhuma unique de entidade de mídia referencia `integration_id` | 0 — conformidade de P10 |
| G2 | Toda tabela de inteligência tem `ad_id` e `organization_id` NOT NULL | teste de schema |
| G3 | Os **sete** índices parciais existem | 7 |
| G4 | `ad_metric_snapshots` particionada, com partições futuras e `DEFAULT` vazia | ≥ 3 meses à frente |
| G5 | Enum `MetricLevel` não existe | 0 |
| G6 | Nenhuma coluna `subject_type`/`subject_id`/`reference_type`/`reference_id` | 0 |
| G7 | `integrations` preservada; nenhum usuário precisa reconectar | contagem antes = depois |
| G8 | Primeiro ingest popula `ads` com FKs resolvidas e `lineage_id` | > 0, sem nulos |
| G9 | `fx_rates` populada com backfill histórico contra o pivô | ≥ 400 dias |
| G10 | `grep -rn "level.*CAMPAIGN" src/modules/{waste,analytics,recommendations}` | vazio |
| G11 | `prisma validate` limpo — nenhum `@@index` com nome de coluna, nenhuma relação sem back-relation | 0 erros |
| G12 | Os quatro `CHECK` de coerência existem (`waste_items` ×2, `alerts`, `ai_decision_logs`) | 4 |
| G13 | `Integration.organization_id` é NOT NULL | conformidade de R-T |
| G14 | Rollup de campanha não multiplica: ad com 3 achados abertos entra 1× | teste de query |
| G15 | Todo campo `Json` normativo tem schema Zod versionado em `domain/` | 5 schemas |

## 14.6 Retenção

| Tabela | Crescimento | Política |
|---|---|---|
| `ad_metric_snapshots` | ~180M linhas/ano na plataforma | particionada; agregação mensal acima de 13 meses |
| `ad_scores` | 1 linha/ad/dia | retenção plena 13 meses; amostragem semanal acima |
| `sync_operations` | 1 linha/conta/hora | retenção 90 dias; contadores agregados preservados |
| `action_executions` | baixo volume | **retenção plena** — é trilha de auditoria (P5) |

## 14.7 Flags de rollout

| Flag | Controla | Default |
|---|---|---|
| `ADS_FIRST_READ_ENABLED` | endpoints `/ads` | `false` → `true` em S2 |
| `CURRENCY_NORMALIZATION_ENABLED` | escrita das colunas `*Base` no ingest | `true` desde S1 |
| `DATA_MATURITY_GATING_ENABLED` | detectores destrutivos exigem `MATURE` | `true` desde S5 |
| `WASTE_DETECTOR_V2_ENABLED` | detector ad-first | `false` → `true` em S5 |
| `AD_SCORING_ENABLED` | worker de scoring | `false` → `true` em S4 |
| `PLATFORM_ACTIONS_ENABLED` | global de escrita | `false` |
| `PLATFORM_ACTIONS_DRY_RUN_ONLY` | força dry-run mesmo com escrita ligada | `true` |
| `VIDEO_PREVIEW_ENABLED` | pipeline ffmpeg em creative-lab | preservado |

`DATA_MATURITY_GATING_ENABLED` nasce `true`. A flag existe para permitir desligar em investigação,
não para adiar a proteção.

---

# 15. Roadmap de implementação

## 15.1 O grafo real de dependências

```text
S0 Decisões + infra transversal  →  S1 Fundação técnica  →  S2 Agregado Ad  →  S3 Sync Engine
                                                                                      │
                                                                                      ▼
                          S7 Escrita: Meta  ←  S6 Recommendation Engine  ←  S5 Waste Detector
                                  │                (sem escrita)               ▲
                    ┌─────────────┴─────────────┐                              │
                    ▼                           ▼               S4 AI Score + Creative Lab
          S8 Google + TikTok            S9 Impacto, reports
```

**Não há paralelismo no caminho crítico até S7.** Cada sprint consome o que o anterior produz, e
isso não é escolha de cronograma — é o que o modelo de domínio impõe:

| Dependência | Razão |
|---|---|
| Waste → AI Score | 4 dos 10 detectores disparam sobre componentes do `AdScore` |
| Waste → Sync | detectores destrutivos exigem `MATURE`; auto-resolve exige observação válida |
| AI Score → Sync | `NegativeFeedbackRisk` depende dos sinais que o sync coleta |
| Creative Lab → AI Score | a análise parte dos componentes do score |
| Tudo → S1 | o schema nasce inteiro na migração destrutiva |
| Tudo → S0 | os 22 eventos e o envelope de §7.0 são pré-requisito de cada módulo, e as decisões que mudam o schema têm de fechar antes da migração |

Só S8 e S9 podem correr em paralelo.

## 15.2 Sprints

| Sprint | Entrega | Duração | Risco |
|---|---|---|---|
| **S0 — Decisões e infra transversal** | as 11 decisões que mudam o schema (§19, `D10..D20`); barramento de eventos com envelope (`eventId`, `eventVersion`, `correlationId`, `causationId`); envelope de resposta, cursor e erro tipado (§7.0); harness de conformidade (lint de P6, testes de camada, gates de schema, procedência) | 1 sem | baixo |
| **S1 — Fundação técnica** | migração de reconstrução (particionada, 7 índices parciais, `CHECK`s, view, `DEFAULT`); os 4 modelos ausentes; `Integration.organizationId` NOT NULL; `platform-clients` com `PlatformCredentialProvider`; `currency` + backfill de FX; `PlatformProfile`; remoção de `campaigns`; ffmpeg parqueado; seed de dev | 2,5 sem | médio |
| **S2 — Agregado Ad** | módulo `ads`; read models; máquina de estados de `syncState`; propriedade de escrita; linhagem; `AdScoreReader` como port; `GET /ads` com cursor e filtros; rotas de contexto; propriedade de rota | 2 sem | baixo |
| **S3 — Sync Engine v2** | cinco fluxos incl. **REBIND**; ingest incremental com checkpoint e lock; guarda de arquivamento; janela de re-declaração por conta e maturidade; `observedAsOf` com fallback; reconcile com drift × mudança externa; quarentena resolvível; saúde de conta; partições; `JobRun`; `alerts` como consumidor puro | 3 sem | **alto** |
| **S4 — AI Score + Creative Lab** | `ad-scoring`; normalização versionada; prior neutro; `coverageRatio` relativo à plataforma; `seriesDiscontinuity`; pisos de confiança consumidos; sinais de feedback negativo; Creative Lab com dispersão robusta; contabilidade e teto de custo de IA | 2,5 sem | médio |
| **S5 — Waste Detector** | duas famílias com atribuição determinística; `DetectorProfile`; `minimumEvidence`; par de grandezas; `findingKind` + view; auto-resolve condicionado; rollups sem dupla contagem; reconciliação de denormalizações; analytics | 2,5 sem | médio |
| **S6 — Recommendation Engine, sem escrita** | policies → ações; conflito por alvo e retorno das diferidas; supressões; guardas de escala; advisory; N:N; `CreativeCandidateResolver`; `RecommendationOutcome` com captura pré-janela | 2,5 sem | médio |
| **S7 — Escrita: Meta** | `platform-actions`; gateway write; consentimento; I2 generalizada; reaper de execução; revalidação; `validationDepth`; escada de verificação; linhagem; reversão; tetos diários; `202`; RBAC, kill switch, auditoria | 3 sem | **alto** |
| **S8 — Google + TikTok + lote** | mesmo subconjunto, um provider por vez; lote com relatório por item | 2 sem | médio |
| **S9 — Impacto, reports, endurecimento** | medição pré/pós sobre a linhagem com taxa única e `measurementVersion`; três tipos de impacto; reports ad-first; remoção de rotas depreciadas; retenção; RLS avaliada; runbook | 2 sem | baixo |

**Ordem interna obrigatória em S4:** `seriesDiscontinuity` entra **antes** da coleta dos sinais de
feedback negativo. Invertida, todo anúncio ativo recebe um salto de score no dia do deploy.

**Mitigação obrigatória em S7:** `PLATFORM_ACTIONS_DRY_RUN_ONLY = true` em produção por duas semanas
antes de liberar escrita real; rollout por organização piloto. Essas duas semanas correm **em
paralelo a S8/S9** — custo de calendário zero, desde que os dois arranquem ao fim de S7.

## 15.3 A conta

| | Original | Revisão arquitetural | Revisão de implementação |
|---|---|---|---|
| Sprints | 8 | 9 | **10** (S0 + S1..S9) |
| Esforço total | 15 semanas | ~20,5 semanas | **~23 semanas** |
| Caminho crítico | 11 semanas (assumindo paralelismo) | ~18,5 semanas (S1→S7) | **~19 semanas** (S0→S7, em série) |
| Calendário até a última entrega | — | — | **~21 semanas** (S8 ∥ S9) |
| Primeira escrita **real** em produção | fim da semana 9 | fim da semana 16,5 | **fim da semana 21** |

A terceira coluna incorpora o custo dos 57 achados da revisão de implementação e as duas semanas de
`DRY_RUN_ONLY` que a segunda declarava como obrigatórias mas não contava.

A afirmação **estrutural** — caminho sequencial, escrita fatiada — decorre do modelo de domínio. A
**numérica** é estimativa de revisão documental, não levantamento de baixo para cima: ±20% é a faixa
honesta.

**Alavancas de escopo**, se o prazo for a restrição dominante:

| Alavanca | Ganho | Custo |
|---|---|---|
| v2.0 só com Meta; Google e TikTok em v2.0.1 | −2 sem | produto monoplataforma no lançamento |
| Adiar reports ad-first | −0,5 sem | relatórios no formato antigo |
| Adiar ações em lote | −1 sem | "pausar os 12 piores" vira 12 cliques |
| Adiar a **superfície** de impacto realizado, mantendo a persistência | −1 sem | o dado é acumulado, a tela vem depois |

**A persistência de `RecommendationOutcome` não é adiável** — é o insumo de P8 e de §20-H3. Adiar a
tela é barato; adiar o registro custa 90 dias de histórico.

---

# 16. Checklist técnico

**16.1 Integridade do domínio** — `ad_id NOT NULL` com FK e cascade em waste, recommendations,
snapshots e scores · `ads.campaign_id NOT NULL`; `ad_set_id` nullable e documentado · nenhuma coluna
`*_external_id` usada como junção lógica em código · enum `MetricLevel` removido ·
`grep -rn "level.*CAMPAIGN"` vazio.

**16.2 Ads-first** — todo endpoint de inteligência aceita filtro por `adId` · toda resposta embute
`AdRef` · nenhum endpoint cria entidade de mídia (P1) · `/campaigns` não expõe verbo de escrita ·
toda `AdAction` com `level != AD` carrega `scopeWarning`.

**16.3 Sincronização** — toda operação produz `SyncOperation` com contadores e `wasComplete` ·
ingest busca insights **apenas** em nível AD · `observedStatus` e `desiredStatus` nunca escritos pelo
mesmo caminho · drift detectado em ≤ 6h com causa provável · debounce de 60 s no refresh · ads
ausentes viram `archivedAt` **apenas** após sync completo.

**16.4 Ações** — nenhum módulo fora de `platform-actions` importa `AdActionGateway` ·
`Idempotency-Key` do cliente; replay devolve o original · `previousState` capturado antes ·
`capabilities()` consultado antes de oferecer · kill switch desliga em < 1 requisição · toda execução
gera `AuditLog` **e** `SecurityAuditLog` · ação não suportada devolve `UNSUPPORTED` com motivo ·
lote > 10 exige dry-run com `validationDepth: PLATFORM`.

**16.5 Scores** — `ad_scores` append-only · todo componente expõe `value`, `normalizedValue`,
`available`, `confidence`, `reasons[]` · `aiConfidence` reflete evidência e cobertura ·
`algoVersion` em toda linha · `inputDigest` evita recomputo · falha de IA não impede a gravação (P4).

**16.6 Arquitetura** — nenhum `import` de `infrastructure` dentro de `domain/` · ports são
`abstract class` · nenhum use case passa de ~150 linhas · calculadoras puras sem I/O e sem
`Date.now()` interno · listagens usam read models · eventos com payload serializável e completo.

**16.7 Multi-tenancy** — toda query de inteligência filtra por `organizationId` · `OwnerScopeResolver`
é o único resolvedor · nenhuma ação atravessa fronteira de organização · `X-Organization-Id`
revalidado em toda escrita.

**16.8 Testes** — detector por tipo, com fronteiras de threshold · calculadoras de score com
cobertura preservada + composto novo · gateways com contract test por plataforma · idempotência:
replay não executa duas vezes · drift: alteração externa detectada · E2E: detectar → recomendar →
aplicar → verificar → resolver → **medir**.

**16.9 Procedência e evidência (P7)** — toda resposta com número derivado carrega `asOf`,
`provenance` e `dataMaturity` · todo detector declara `minimumEvidence` e falha em teste se dispara
abaixo dela · nenhum consumidor de score ignora `confidence` e `componentCoverage` · impacto medido é
rotulado `observedDelta`.

**16.10 Moeda (D3.2)** — nenhum módulo fora de `currency` converte, arredonda ou lê `fx_rates` ·
toda linha monetária tem original **e** `*Base` com taxa e data · parâmetro de orçamento é rejeitado
se não estiver na moeda da conta (M3) · agregações somam normalizados; nenhuma converte um agregado.

**16.11 Maturidade e observação** — `ZERO_CONVERSIONS`, `LOW_ROAS` e `HIGH_CPA` só disparam em
`MATURE` · auto-resolve exige sync bem-sucedido e completo · arquivamento exige resposta completa ·
escrita de `observedStatus` respeita a guarda de recência.

**16.12 Identidade (P10)** — nenhuma unique de mídia referencia `integration_id` · reconectar
preserva ids e contagens · ad derivado herda `lineageId` via `resultPlatformEntityId`.

**16.13 Invariantes de banco** — os **sete** índices parciais existem · os quatro `CHECK` de coerência
existem · `ad_metric_snapshots` particionada com partições futuras e `DEFAULT` vazia · a view
`open_waste` é o único caminho de agregação · nenhuma agregação soma coluna do lado 1 de um join 1:N.

**16.14 Jobs e coordenação** — todo job agendado adquire a janela pelo takeover condicional de
`JobRun` · toda escrita do worker sobre `job_runs` carrega a guarda de `attempt` · nenhum job conclui
sem posse verificada · dependência entre etapas é resolvida por consulta a `JobRun`, nunca por
sequência de horário · execução de ação em plataforma não roda sob lease de `JobRun`.

**16.15 Rastreabilidade** — todo evento carrega `eventId`, `eventVersion`, `correlationId` e
`causationId` · todo payload de job Bull carrega `JobContext` · `correlationId` presente nas sete
tabelas forenses · handler de evento que faz I/O pesado apenas enfileira.

**16.16 Ciclo de vida** — nenhum status não terminal fica sem caminho de saída: `SKIPPED` é
retentável na mesma janela, `DEFERRED_BY_CONFLICT` volta a `NEW` quando o conflito cessa,
`SyncQuarantine` é reprocessada, `ActionExecution` vencida é varrida,
`RecommendationOutcome.PENDING_MEASUREMENT` é medido ou abandonado.

---

# 17. Critérios de aceite

## 17.1 Por princípio

| Princípio | Critério verificável |
|---|---|
| **P1** | Nenhuma rota `POST`/`PUT` cria entidade de mídia. Varredura do `RouteExplorer`; handlers de ação são permitidos e verificados por não executarem `create` fora do sync. |
| **P2** | Toda tabela de inteligência tem `ad_id NOT NULL`; nenhum valor monetário acima do anúncio; achados relacionais com `scopeLevel` e `relatedAdIds`. |
| **P3** | Nenhuma `AdAction` sem `origin`; `origin = RECOMMENDATION` sem `recommendationId` é erro de schema. |
| **P4** | Com todos os providers de IA desligados, score, waste e recomendação continuam sendo produzidos. E2E com IA mockada em falha. |
| **P5** | Nenhuma ação executa sem RBAC ok, kill switch off, consentimento registrado, revalidação e audit gravado. Teste por caminho. |
| **P6** | Nenhum `if (platform === 'META')` fora de `infrastructure/providers/`. Regra de lint. |
| **P7** | Nenhuma resposta com número derivado sem `asOf` + versão. Detector que dispara abaixo de `minimumEvidence` falha em teste. |
| **P8** | Toda `Recommendation` em `APPLIED` com janela pós completa tem outcome persistido. Nenhuma mudança de threshold sem relatório de replay. |
| **P9** | Nenhuma chamada de LLM por anúncio-dia sem mudança de digest. Custo por anúncio-dia observável com teto. |
| **P10** | Desconectar/reconectar preserva `ads.id`, `lineage_id` e contagens de séries. |

## 17.2 Não-funcionais

| Métrica | Alvo |
|---|---|
| `GET /ads` (10k ads na org) | p95 < 400 ms |
| `GET /ads/{id}/analysis` | p95 < 250 ms |
| `/waste/rollup` (100k ads) | p95 < 500 ms |
| Ingest de 1 AdAccount com 5k ads | < 5 min |
| Latência de execução de ação (enfileirar → plataforma) | p95 < 10 s |
| Verificação pós-ação | escada 90 s → 2 h |
| Cobertura de testes nos módulos tocados | ≥ 80% |
| Chamadas à API de plataforma por ingest | redução ≥ 60% vs. v1 |

## 17.3 Definition of Done

A v2.0 está entregue quando um usuário consegue, sem sair da Allva:

1. **Ver** todos os seus anúncios, de todas as plataformas, ordenados por desperdício evitável ou
   queda de score;
2. **Entender** por que um anúncio está mal — com número, componente, evidência e procedência;
3. **Agir** sobre esse anúncio com um clique, aplicando a recomendação;
4. **Confirmar** que a ação foi aplicada de fato na plataforma;
5. **Medir** o que aconteceu com o desempenho depois;
6. **Registrar** o resultado medido como fato — sem o passo 6, os horizontes H2 e H3 não têm insumo.

---

# 18. Riscos arquiteturais

| # | Risco | Prob. · Impacto | Mitigação |
|---|---|---|---|
| **R1** | Bug em `platform-actions` pausa anúncios que performavam, ou reativa anúncios pausados de propósito | média · **crítico** | `PLATFORM_ACTIONS_DRY_RUN_ONLY` por padrão; kill switch; RBAC por tipo; teto diário; lote máx. 100; `previousState`; auditoria dupla; rollout piloto → 10% → geral; contract tests |
| **R4** | Rate limits das plataformas | alta · médio | ingest ad-first reduz volume; incremental por `updated_since`; debounce; token bucket único em `platform-clients`; respeitar `Retry-After` |
| **R5** | Cardinalidade de `ad_metric_snapshots` | média · médio | **particionada desde a criação**; retenção por `DROP PARTITION`; agregação mensal acima de 13 meses |
| **R6** | Ads efêmeros e churn de identidade | média · médio | `lineageId` + `resultPlatformEntityId`; análise de impacto segue a linhagem |
| **R7** | Escopo da escrita | alta · alto | **estrutural**: S6 sem escrita + S7 só Meta + S8 demais; subconjunto mínimo de ações primeiro |
| **R8** | Divergência semântica entre plataformas | alta · baixo | `AdStatus` canônico com mapeamento em `PlatformProfile`; `observedRawStatus` preserva o original; `capabilities()` declara irreversibilidade |
| **R9** | Regressão de tenancy durante o refactor | média · **crítico** | `organizationId NOT NULL` denormalizado em tudo; teste de tenancy por endpoint; RLS avaliado em S9 |
| **R11** | Caminho crítico inteiramente em série | alta · alto | fatiar entregas dentro de cada sprint; S8 e S9 em paralelo; alavancas de escopo declaradas (§15.3) |
| **R12** | A janela de reconstrução fecha no primeiro onboarding real | média · alto | S1 antes de qualquer cliente conectar conta real |
| **R13** | Dependência de provedor de câmbio na ingestão | média · médio | `pending` em vez de bloquear; taxa mais recente ≤ data; cache indefinido de taxa histórica |
| **R14** | **Conteúdo escrito por LLM publicado como anúncio, sob a marca do cliente** | média · alto | `aiAuthored` obrigatório; confirmação explícita do texto final, nunca em lote; proibido em automação mesmo em v2.2; registro em auditoria como conteúdo publicado |

R14 não é risco técnico — é exposição de marca e potencialmente jurídica.

---

# 19. Decisões de produto

| # | Decisão | Estado |
|---|---|---|
| **D1** | Pipeline local de campanha removido, não migrado | fechada — zero usuários |
| **D2** | `GET /campaigns` repontado para campanhas sincronizadas | inofensiva — a lista está vazia |
| **D3** | Desperdício não é somável entre tipos; ampliado para o par incorrido/evitável | fechada |
| **D4** | Ações são opt-in por organização (`actionsEnabled` começa `false`; só `OWNER` habilita) | fechada |
| **D5** | Sem automação de ações na v2.0 — toda ação exige clique humano | fechada |
| **D6** | Impacto é medido, não atribuído — `observedDelta` com `confounders` | fechada |
| **D7** | Ads arquivados são preservados (`archivedAt`), nunca deletados | fechada |
| **D8** | Janela única de scoring (14 dias, configurável por org, gravada) | fechada |
| **D3.1** | `organizationId` obrigatório — modelo Organization-First | fechada |
| **D3.2** | Dupla persistência monetária: original imutável + normalizado em moeda-base | fechada |
| **D3.3 → P10** | Identidade sobrevive à reconexão | fechada, virou princípio |
| **D3.4** | Troca de moeda-base permitida, com Normalization e Migration Service | fechada |
| **D7.1** | Superfície de pré-veiculação fora do escopo da v2.0; tabela permanece | fechada |
| **D9.1** | Domínio de mídia sem dado relevante → reconstrução em vez de migração | fechada |

## 19.1 Decisões da revisão de implementação

Onze pontos em que a primeira redação admitia mais de uma leitura, e a escolha muda o schema.
Fechadas antes da migração destrutiva, em A2-S0.

| # | Decisão | Alternativa rejeitada, e por quê |
|---|---|---|
| **D10** | `waste_items` mantém `status` **e** `resolved_at`, com `CHECK` de coerência; `WasteStatus` reduzido a `{OPEN, RESOLVED}` | Dropar `status` custaria o índice de listagem. Manter a nuance nos dois enums é o que produz a divergência: ela vive inteira em `WasteResolutionKind`. |
| **D11** | Os pisos de §12.4 incidem sobre `coverageRatio`, relativo ao `PlatformProfile` | Piso absoluto elimina Google Search de toda ordenação e todo alerta — o produto multi-plataforma some da tela que o define. |
| **D12** | `HIGH_CPA` com < 3 pares cai para o baseline da conta, com limiar 1,5× e `evidenceSufficiency: PARTIAL` | Exigir 3 pares silenciaria contas com um anúncio por ad set — a estrutura mais comum em contas pequenas, onde desperdício dói mais. |
| **D13** | `AUDIENCE_SATURATION` v2.0 opera sobre tendência de frequência; reach deduplicado fica para S8 ou v2.1 | Reach diário não é somável em reach semanal. Exigi-lo agora acrescentaria uma chamada por ad set ao orçamento de R4 sem decisão tomada. |
| **D14** | `OVERLAPPING_DELIVERY` v2.0 é mesmo `contentHash` no mesmo ad set | Sobreposição real de público não é computável com o que o sync coleta, e dentro do conjunto é tautológica. Cross-ad-set já está no Horizonte 2. |
| **D15** | `RecommendationOutcome` é 0:1, com `primaryImpactType` declarado na geração e `secondaryDeltas` como contexto | 1:N por tipo faria a mesma recomendação entrar várias vezes no denominador de acurácia de P8. |
| **D16** | Configuração por organização em `OrganizationAdsSettings`; **janela de re-declaração em `AdAccount`** | Pôr a janela de re-declaração na organização trataria contas de 7 e 28 dias de atribuição igual, perdendo conversões retroativas sempre nas mesmas contas. |
| **D17** | `AdAccount` ganha `syncHealth` com três estados | Sem estado de conta, a guarda de arquivamento e a tabela de degradação não têm sujeito. |
| **D18** | `WasteItem` ↔ `ActionExecution` é FK real com `onDelete: SetNull` | `action_executions` tem retenção plena (§14.6); a FK nunca fica pendurada. Coluna solta não é navegável. |
| **D19** | Provedor de FX com histórico por data; backfill de 400 dias no deploy; carry-forward para trás, nunca extrapolação | Só taxa spot torna M2 inaplicável: o primeiro ingest lê 14+ dias e entraria inteiro com `normalizationPending`. |
| **D20** | A denormalização de waste **não** ganha dimensão de janela; o rollup deixa de filtrar por ela e a declara em `meta.provenance` | Dimensionar a denormalização por janela multiplicaria as colunas em `ads` por cada janela ativa, para servir um filtro que a UI não expõe. |

## 19.2 Decisões pós-v2.0 (2026-09-22)

| # | Decisão | Alternativa rejeitada, e por quê |
|---|---|---|
| **D21** | **Objetivo de otimização por anúncio.** Cada provider traduz o vocabulário da plataforma (meta de otimização, evento, estratégia de lance, objetivo) para uma taxonomia canônica — `optimizationClass` (`CONVERSION`/`TRAFFIC`/`AWARENESS`/`ENGAGEMENT`/`UNKNOWN`), `conversionEvent` (compra, lead, cadastro, instalação, mensagem, conversão personalizada...) e `conversionMeasurable` — gravada em `campaigns` e `ad_sets`. O anúncio resolve pelo conjunto e, na falta, pela campanha. `ZERO_CONVERSIONS`, `LOW_ROAS` e `HIGH_CPA`, o `audienceFit` do score, a escala e a troca de CTA só valem para anúncio julgável por conversão; a linha de base da conta compara só anúncios com o mesmo objetivo e evento. No Meta, a conversão passa a ser o evento do conjunto (`promoted_object`), não mais só compra; escala e troca de CTA usam CPA quando o evento não tem valor. `UNKNOWN` não é julgado por conversão. | Manter "conversão = compra" e deixar o resto em silêncio. Não era silêncio: com zero compras, anúncio de lead, alcance ou tráfego recebia `ZERO_CONVERSIONS` e recomendação de pausa — o falso positivo que P7 existe para impedir. Traduzir no domínio violaria P6. |
| **D22** | **Silêncio explicado.** A insuficiência que o portão de evidência já calculava por detector deixa de ser só contada: vira `ads.evidence_gaps` (motivo, detectores afetados, o que falta e estimativa de quando chega, pelo ritmo recente e pela defasagem da janela julgada), exposta em `GET /ads/{id}/evidence` e resumida em `GET /waste/evidence`. Os pisos de evidência **não** foram baixados. | Baixar os pisos para contas pequenas "falarem" mais cedo: trocaria silêncio por falso positivo. Mostrar lista vazia: indistinguível de "olhamos e está tudo bem". |

Efeitos de versão: `spend-efficiency` e `LOW_CTR` passam a `v2.1.0` (portão de objetivo e linha de base
segmentada); `active_algo_version` passa a `deterministic-v2.2` (o `audienceFit` deixa de valer fora
de conversão e o teto de cobertura deixa de cobrar o peso dele). Migração
`20260922100000_objetivo_de_otimizacao_e_lacunas_de_evidencia`.

> **Validação pendente.** O mapa de `action_type` do Meta por evento segue a documentação da Graph API
> e não foi conferido contra conta real — nenhuma estava conectada. Os primeiros parceiros devem
> confirmar, evento a evento, que a contagem bate com a coluna "Resultados" do Gerenciador.

| # | Decisão | Alternativa rejeitada |
|---|---|---|
| **D23** | **Performance Max entra na análise pelo grupo de recursos.** Campanha PMax não tem grupo de anúncios nem anúncio — `FROM ad_group_ad` não devolvia nada dela, e o gasto ficava fora do score, da detecção, das recomendações e dos totais (o ritmo de orçamento a mostrava "abaixo do ritmo" com gasto zero). O grupo de recursos (`asset_group`) vira a unidade: `ads.unit_kind = ASSET_GROUP`, `adSetId` nulo, id externo prefixado (`asset_group:<id>`, para não colidir com id de anúncio), série própria (`FROM asset_group` + `segments.date`) e o pacote de recursos (títulos, descrições, imagens, vídeos, chamada) como criativo, `format = PERFORMANCE_MAX`. Conta no teto de anúncios analisados. A unidade sem conjunto compara-se com as da mesma campanha (`peerGroupKeyOf`), e o grupo de recursos tem régua de conta própria (`benchmarkKeyOf`: `ASSET_GROUP\|<objetivo>`). Só a conta com PMax paga as três leituras a mais. Ação só é oferecida na unidade que a capacidade declara (`AdActionCapability.units`, padrão fechado em `AD`, **em todos os níveis** desde D24). No Google, pausar e reativar declaram o grupo de recursos (`assetGroups:mutate`, reversão pelo status próprio, observação pela mesma composição do sync), e as ações de campanha também, porque a campanha PMax é campanha comum; trocar texto, duplicar e remover seguem recusados no grupo. | Deixar o PMax declarado em "cobertura" e fora da análise: é o formato em que o Google mais concentra verba. Tratar a campanha inteira como unidade: esconde qual grupo desperdiça. Modelar o grupo como conjunto **e** anúncio: cada grupo ficaria sozinho no próprio conjunto, sem par, e todo detector relativo recusaria. |

Migração `20260922120000_unidade_grupo_de_recursos` (aditiva: todo anúncio existente é `AD`).

**Criativo do grupo.** O sinal criativo que o PMax expõe é a classificação de cada recurso
(`asset_group_asset.performance_label`: Melhor, Bom, Baixo, Aprendendo), lida em consulta acessória e
gravada em `metadata.copyAssets` junto de títulos, títulos longos e descrições; `GET /creatives/{id}`
a expõe como `performanceLabel` e o detalhe do grupo a mostra como classificação **do Google**. O Copy
Studio gera texto para o grupo e o declara não aplicável (`REPLACE_COPY` não cobre `PERFORMANCE_MAX`):
trocar recurso no PMax exige criar o asset e religá-lo ao grupo, fora do escopo até haver conta real
para validar. **Mix de canais** (quanto do grupo foi para busca, YouTube, display, Gmail) fica no
roadmap: a disponibilidade do recorte por canal na API não foi confirmada.

| # | Decisão | Alternativa rejeitada |
|---|---|---|
| **D24** | **Smart+ do TikTok pelas rotas próprias, só onde as padrão não chegam — desligado até validar.** Escrito a partir do SDK oficial (`tiktok/tiktok-business-api-sdk`), sem conta real: `/smart_plus/campaign\|adgroup\|ad/get/` e a série diária de `/smart_plus/material_report/breakdown/` (dimensão `stat_time_day`, filtro `smart_plus_ad_ids`, uma consulta por anúncio). O anúncio Smart+ é pacote de vários criativos que o TikTok combina — a unidade é ele, `unit_kind = ASSET_GROUP`, com grupo de anúncios, id `smart_plus_ad_id` sem prefixo e `format = SMART_PLUS`. **Lacuna por campanha:** campanha em que `/ad/get/` já devolveu anúncios não ganha unidade nova — o anúncio Smart+ de mesmo id só troca de representação (vira pacote) e a série segue do relatório padrão; id diferente em campanha coberta é ignorado. Campanha não coberta entra inteira pela rota própria, com a série do relatório próprio, só para anúncios que o relatório padrão não trouxe. Falha nas rotas Smart+ é falha de etapa (sem ela, a varredura arquivaria o que só elas enxergam). Nenhuma ação é oferecida sobre a unidade Smart+ — a trava por unidade passou a valer também para campanha e conjunto, que no Smart+ têm rotas próprias. Interruptor `TIKTOK_SMART_PLUS_ENABLED`, padrão `false`. | Esperar a conta real para escrever tudo: a parte estrutural sai quase certa da documentação, e o risco fica isolado em `tiktok-smart-plus.ts`. Lacuna por anúncio: se as duas rotas usarem ids diferentes para o mesmo anúncio, o gasto entraria duas vezes. Ligar por padrão: uma rota errada deixaria toda conta TikTok com leitura incompleta, sem arquivar nada. |

> **Validação antes de ligar.** `pnpm verify:tiktok-smart-plus -- --advertiser=<id> --compare` roda o provider
> com a leitura desligada e ligada e compara o gasto das campanhas Smart+ com o gasto por campanha do
> relatório: "PODE LIGAR" só com leitura completa e gasto batendo em ±2%. Pontos que a conta real decide:
> se `smart_plus_ad_id` é o mesmo número de `ad_id`, o `page_size` máximo do relatório por material, se
> `complete_payment_roas` é aceito ali, e se a rota própria recusa conta sem Smart+.

> **Validação pendente.** Os campos de `asset_group`, `asset_group_asset` e `asset` seguem a documentação
> da Google Ads API e não foram conferidos contra conta real. As consultas de recursos e de série têm
> escada de recusa (400 relê com menos campos), mas a primeira conta com PMax deve confirmar que gasto
> e conversões por grupo somam o da campanha.

---

# 20. Roadmap de evolução

## Horizonte 1 — v2.0 *(S1 → S9, ~20 semanas)*

O escopo deste documento. Entrega `INGEST → SCORE → DETECT → RECOMMEND → APPLY → VERIFY`, ancorado
no anúncio, e **produz o dataset de LEARN** sem ainda consumi-lo.

## Horizonte 2 — v2.1: inteligência comparativa e calibração

- **Benchmarks entre contas** — percentis anonimizados por vertical e plataforma
- **Detecção de anomalia** — desvio da própria linha de base do anúncio, não de threshold fixo
- **Score preditivo** — probabilidade de fadiga em 7 dias, treinada no histórico real
- **Análise de portfólio** — sobreposição de público entre ad sets, canibalização
- **Score de criativo entre contas** — via `contentHash`
- **Calibração de P8** — thresholds e pesos ajustados a partir de `recommendation_outcomes`,
  versionados e validados por replay. É aqui que o `LEARN` passa de coleta a uso.

## Horizonte 3 — v2.2: automação supervisionada

Pré-requisito medível, com fonte de dado declarada: `verificationResult = CONFIRMED` > 95% e
reversão manual < 5% ao longo de 90 dias, calculados sobre `recommendation_outcomes`.

- Regras propostas pela IA a partir do padrão de aprovação do usuário
- Guardrails: teto de gasto afetado por dia, exigência de N dias de dados, horário
- Modo de aprovação em lote
- Reversão automática se a métrica piorar

> Conteúdo autoral de IA permanece **fora** da automação, mesmo aqui (R14). Pausar um anúncio
> automaticamente é reversível; publicar copy escrita por um modelo sob a marca do cliente, não.

## Horizonte 4 — v3.0: expansão

LinkedIn, Pinterest e Amazon Ads entram como **configuração de `PlatformProfile`** mais um adapter,
sem mudança de domínio — o que só é verdade porque o perfil declara forma de hierarquia, vocabulário
de status, métricas disponíveis e semântica de identidade. Sinais de pós-clique para fechar o gap de
`AudienceFit`. Análise multimodal de criativo alimentando `Attention` com sinal direto.

## O que permanece fora de escopo, permanentemente

- Criação de campanhas, conjuntos ou anúncios
- Editor de criativo ou construtor de anúncio
- Gestão de públicos, pixels ou catálogos
- Qualquer funcionalidade cuja ausência force o usuário a escolher entre a Allva e o Ads Manager

**A Allva convive com o Ads Manager. Não o substitui.**

---

# Apêndice A — Achados de código que motivaram o redesenho

| # | Achado | Gravidade |
|---|---|---|
| 1 | `ExternalAd` é write-only: `listByAdAccountId` não tem nenhum chamador | **Crítica** |
| 2 | Desperdício contado até 4× (uma vez por nível) | **Crítica** |
| 3 | Todos os 6 scores de IA presos a campanhas ficcionais | **Crítica** |
| 4 | Nenhum caminho de escrita para nenhuma plataforma | **Crítica** |
| 5 | Recomendação entrega texto em prosa para humano executar | **Crítica** |
| 6 | Impossível resolver a mesma condição de waste duas vezes (colisão na unique) | Alta |
| 7 | Benchmark de CPA compara anúncio contra média de campanhas | Alta |
| 8 | Alertas de waste nunca recebem `referenceId` | Alta |
| 9 | Título de recomendação usa a palavra do nível como nome da entidade | Alta |
| 10 | Métricas de CREATIVE são derivadas de AD por agregação | Média |
| 11 | `campaignLevelOnly()` existe só para compensar a dupla contagem | Média |
| 12 | Scores nunca persistidos — recalculados a cada request | Média |
| 13 | `NegativeFeedbackRisk` opera sobre proxies; sinais reais não coletados | Média |
| 14 | `scoreEstimate` é o composto real do produto, mas é `private` e não persistido | Média |
| 15 | `POST /campaigns/ai/generate-{title,description}` gera copy para campanha nova | Média |

> As referências de arquivo e linha estão no documento original e nos capítulos de revisão. Este
> documento assume os achados como verificados.

# Apêndice B — Achados da revisão arquitetural

Os catorze achados críticos identificados na revisão dos dez capítulos:

| Cap. | Achado |
|---|---|
| 1 | O ciclo de valor não fechava — faltava `LEARN` |
| 1 | P1 era violado pelo próprio documento (`DUPLICATE_AD`, `requiresRecreate`) |
| 1 | P3 forçaria recomendações sintéticas, contaminando o dataset de acurácia |
| 2 | O agregado não protegia sua única invariante crítica (concorrência de escrita) |
| 2 | Cinco módulos escreviam na raiz sem dono declarado |
| 2 | O grafo de dependências estava errado; a regra de mútua ignorância era falsa |
| 3 | O rollup de desperdício recriava a dupla contagem no eixo tipo |
| 3 | As duas uniques que corrigiriam bugs não funcionam no Postgres |
| 3 | Identidade ancorada na credencial: reconectar forkava todo o histórico |
| 3 | Não existia moeda em nenhum lugar do modelo monetário |
| 4 | Métricas são re-declaradas pelas plataformas, e o sync ignorava isso |
| 4 | Integração indisponível resolvia falsamente todo o desperdício aberto |
| 5 | A métrica de capa misturava dinheiro queimado com economia futura |
| 6 | Uma recomendação podia ser aplicada com a premissa vencida |
| 7 | A confiança era calculada com rigor e ignorada por todos os consumidores |
| 10 | Os três sprints declarados paralelos eram sequenciais |

# Apêndice C — Ativos preservados

| Ativo | Local | Por quê |
|---|---|---|
| Calculadoras de score puras | `creative-lab/domain/scoring/` → `ad-scoring/` | determinísticas, testáveis, com `confidence` e `reasons`. Só mudam de endereço |
| Roteamento multi-provider de IA | `ai/infrastructure/routing/` | classificação de erro, cooldown, backoff com jitter, health registry — maduro e agnóstico |
| Camadas Clean Architecture | todos os módulos | `domain/application/infrastructure` com ports como `abstract class` |
| Modelo de alertas | `alerts/` | fingerprint, dedupe, `occurrences`, lifecycle, política de entrega |
| Infra de auditoria | `audit/` | vocabulário + `audit-coverage.spec.ts` |
| RBAC e multi-tenancy | `organizations/`, `security/` | matriz de permissões, anti-escalação, `OwnerScopeResolverService` |
| Segurança de credenciais | `shared/infrastructure/security/` | AES-GCM `TokenCipherService`, lockout progressivo, detecção de replay |
| Infra de filas Bull | workers de todos os módulos | padrão dispatcher/worker/scheduler consistente |
| Seam determinístico → IA | `creative-lab`, `recommendations` | P4 já implementado corretamente; é o modelo a replicar |

# Apêndice D — Achados da revisão de implementação

Segunda passagem (2026-07-30), verificando se o documento vira código sem ambiguidade. 41 achados
diretos e 16 derivados — estes últimos só visíveis ao escrever a correção. Todos aplicados neste
documento; rastreabilidade completa achado → sprint em `PLAN.md`.

| Classe | Qtd. | Exemplos representativos |
|---|---|---|
| **A — Schema** | 12 | índices com nome de coluna; 4 modelos citados e nunca definidos; `idempotencyKey` global vazando entre tenants; duas fontes de verdade para "aberto" |
| **B — Contradição interna** | 8 | o rollup de §10.8 reintroduzia a dupla contagem que o documento existe para eliminar; a cobertura absoluta apagava Google Search da tela principal; `HIGH_CPA` exigia 3 pares e mandava cair para a conta |
| **C — Lacuna operacional** | 10 | ninguém criava partições futuras, varria `expiresAt`, media a janela pós nem fazia backfill de FX; o pré-janela do outcome nunca era capturado |
| **D — Módulos** | 8 | ciclo `platform-clients` ↔ `integrations`; dono de `AdScoreView` indefinido; barramento de eventos inexistente |
| **E — Cronograma** | 3 | as 2 semanas de dry-run obrigatório fora da conta |
| **⊕ Derivados** | 16 | `SKIPPED` inutilizaria a janela sob `ON CONFLICT DO NOTHING`; `causationId` exige `eventId`; `Alert.updatedAt` não pode ser última ocorrência; `post*` NOT NULL tornava a captura pré impossível |

Quatro derivados **bloqueavam** a implementação daquilo que corrigiam — escrever a correção era
impossível sem resolvê-los antes:

| ⊕ | Bloqueio |
|---|---|
| takeover condicional de `JobRun` | sem ele, `SKIPPED` ocupa o slot da janela e cria buraco silencioso de processamento |
| guarda de posse em toda escrita | sem ela, um worker zumbi marca como `SUCCEEDED` uma janela que não fez — e `SUCCEEDED` nunca reexecuta |
| campos nullable em `RecommendationOutcome` | sem eles, a captura pré-janela é literalmente impossível |
| sexta FK em `Alert` | sem ela, `SYNC_QUARANTINE` nasce órfão — o bug que o modelo existe para impedir |

---

*Documento gerado a partir da revisão arquitetural em dez capítulos
(`chapter-1..10-allva-ads-arch.md`) e da revisão de implementação de 2026-07-30, feita contra o
código. Os capítulos permanecem como registro da análise, das alternativas consideradas e da
justificativa de cada correção.*
