# Segredo crítico vs. opcional

> **Status:** regra definida no Sprint 5.5 (**P-6**) e **implementada no Sprint 6**
> (Ops readiness). O guard vive em `envSchema.superRefine` + `ConfigReadinessService`;
> as regras puras e testáveis estão em `shared/infrastructure/config/config-readiness.ts`.
>
> **D-1 … D-5: todas resolvidas** no Sprint 6. O schema agora corresponde à regra
> descrita aqui, e não há divergência conhecida em aberto.

## Por que a regra vem antes do guard

O Sprint 5 corrigiu exatamente o erro que um guard de boot mal desenhado reintroduz:
o `AnthropicClient` instanciava o SDK no construtor e **derrubava a aplicação inteira**
por falta de `ANTHROPIC_API_KEY` — uma chave **opcional**, cujo provider tem fallback.

Sem uma linha traçada entre "sem isto a aplicação não funciona" e "sem isto uma
feature degrada", o guard volta a transformar configuração ausente em indisponibilidade
total. Daí a regra:

| Classe | Comportamento na ausência | Critério |
|---|---|---|
| **Crítico** | **Falha no boot**, com mensagem nomeando a variável | Sem ela, nenhuma requisição pode ser atendida com segurança ou correção |
| **Opcional** | **Degrada**, com log de nível `warn`/`error` no boot | A ausência desabilita uma feature; o resto da aplicação segue correto |

Duas consequências que o guard precisa respeitar:

1. **Opcional nunca lança no construtor.** Resolução preguiçosa (lazy) ou checagem no
   ponto de uso — o padrão que `AnthropicClient` e `FfmpegBinaryLocator` já seguem.
2. **Ausência de opcional precisa ser observável.** Degradar em silêncio é como o
   ffmpeg ficou meses quebrando só dentro do log de um job (P-3). Log no boot, e
   componente em `/health` quando fizer sentido — sem devolver 503 por acessório.

## Classificação

### Crítico — falha no boot

| Variável | Por quê |
|---|---|
| `DATABASE_URL` | Sem banco não há requisição atendível |
| `JWT_SECRET_KEY` | Sem chave de assinatura, autenticação é insegura (já exige ≥ 32 chars) |
| `REDIS_URL` | Filas (Bull) em caminhos de escrita — 7 filas/crons param sem ele. **Não** é usado por rate limiting: o throttler global é in-memory por instância, ver `runbook.md` |
| `INTEGRATION_TOKEN_ENCRYPTION_KEY` | Tokens de integração em repouso; sem ela, ou não lê ou grava em claro |
| `FRONTEND_URL` | Base de CORS e dos links de e-mail (verificação, reset de senha) |
| `STRIPE_WEBHOOK_SECRET` | **Só em produção.** Ver "Condicionalmente crítico" |

### Condicionalmente crítico — crítico apenas em produção

Segredos de webhook de billing. Um endpoint de webhook **sem verificação de
assinatura** aceita evento forjado, e evento de billing forjado altera assinatura e
acesso. Fora de produção precisam ser opcionais, senão nenhum dev sobe a aplicação.

Regra: se `NODE_ENV === 'production'` **e** o provedor correspondente está configurado
(`STRIPE_SECRET_KEY` presente), o segredo de webhook é obrigatório. Provedor não
configurado não exige segredo.

### Opcional — degrada com log

| Variável / grupo | O que degrada |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_*` | Rota de copy cai no fallback; o orquestrador já trata isso |
| `OPENAI_API_KEY` | Análise estruturada fica sem provider primário (ver divergência D-1) |
| `GCS_*` (`PROJECT_ID`, `BUCKET`) | `STORAGE_PROVIDER=GCS` (padrão) sem bucket → upload, preview e PDF recusados com `STORAGE_NOT_CONFIGURED` |
| `GCS_CLIENT_EMAIL`/`GCS_PRIVATE_KEY`, `GCS_KEY_FILENAME` | Nenhum dos dois → Application Default Credentials, que é o modo recomendado dentro do Google Cloud. **Meio par é reportado**: o SDK o ignora inteiro |
| `GCS_PUBLIC_BASE_URL` | URL de leitura sai no host padrão do bucket em vez do CDN |
| `API_PUBLIC_URL` | O e-mail de relatório aponta para o relatório no app em vez de baixar o PDF direto; nada mais muda |
| `AWS_*` (`REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `S3_BUCKET`) | Só cobradas quando `STORAGE_PROVIDER=S3`; incompletas, mesmo efeito do GCS acima |
| `FFMPEG_PATH` | Cai no binário do `ffmpeg-static`; readiness em `/health` (P-3) |
| `SMTP_*`, `BREVO_API_KEY`, `EMAIL_FROM*` | `EMAIL_PROVIDER` diferente de `console` sem credencial → e-mail não sai |
| `ALLVA_SUPPORT_EMAIL` | Destinatário exclusivo do Drawer de suporte (nunca remetente). Ausente → `POST /api/v1/support/messages` responde `SUPPORT_EMAIL_NOT_CONFIGURED` (503) em vez de enviar |
| `STRIPE_*` (chaves e preços) | Checkout indisponível — é o único provedor de billing |
| `GOOGLE_ADS_*`, `TIKTOK_ADS_*` | Aquele provider de ads não conecta (ver divergência D-2) |
| `CORS_ALLOWED_ORIGINS` | Só `FRONTEND_URL` é aceito |
| `TRUSTED_PROXIES` | Cai em "um hop": correto atrás de exatamente um balanceador, mas confia em qualquer peer imediato — quem alcançar a API direto passa a poder declarar o próprio IP e renovar a cota de rate limit a cada requisição |
| Tudo com `.default()` | Comportamento padrão documentado, nunca ausência |

## Divergências entre a regra e o schema — histórico (todas resolvidas)

Quando esta regra foi escrita, o `envSchema` falhava no boot para **12** variáveis, e a
lista não correspondia à classificação. Hoje falha para **5** — exatamente as críticas.

| ID | Divergência | Como foi resolvida |
|---|---|---|
| **D-1** | `OPENAI_API_KEY` era obrigatório. Contradizia a lição do Sprint 5: chave de provider de IA, com fallback e cooldown já implementados | Opcional. `OpenAIClient` ganhou `isConfigured()` + checagem explícita da chave, devolvendo erro diagnosticável em vez do throw interno do SDK |
| **D-2** | `META_APP_*` e `GOOGLE_CLIENT_ID` obrigatórios, enquanto `GOOGLE_ADS_*` / `TIKTOK_ADS_*` — mesma natureza — eram opcionais | Todas opcionais. `MetaAdsProvider` recebeu o mesmo `requireConfig()`; os verificadores de SSO já devolviam `GOOGLE_SSO_NOT_CONFIGURED` / `FACEBOOK_SSO_NOT_CONFIGURED`. |
| **D-3** | Segredos de webhook de billing eram opcionais — o inverso exato do risco | Condicionalmente críticos + fail-closed no controller. Ver "D-3 em detalhe" |
| **D-4** | `JWT_EXPIRES_IN` obrigatório sem ser segredo nem decisão de infra | `.default('7d')`, **e** `JwtJoseProvider` passou a ler por `EnvService` — um default do Zod nunca chega ao `process.env`, então `String(process.env...)` continuaria produzindo `"undefined"` |
| **D-5** | `EnvService.get()` resolvia para `never` em toda chave, então nenhum call site reclamava de variável opcional usada como obrigatória | Retorno anotado como `Env[K]`; os 3 providers de ads trocaram `ensureConfigured()` por `requireConfig()` |

### Por que a ordem D-5 → D-2 importou

Provado na prática: tornar `META_APP_*` opcional **depois** de corrigir o tipo fez o `tsc`
apontar na hora 7 usos em `meta-ads.provider.ts`. Se a ordem tivesse sido a inversa, esses
7 usos teriam continuado compilando — e `undefined` entraria no OAuth do Meta sem aviso.
É exatamente o modo de falha que D-5 esconde.

### Armadilha registrada: `stripe.client.ts`

`STRIPE_SECRET_KEY` é opcional, e o cliente Stripe é um **singleton de módulo**. Medido:

```
new Stripe(undefined)    -> lança "Neither apiKey nor config.authenticator provided"
new Stripe('')           -> lança (string vazia é falsy para o SDK)
new Stripe('qualquer')   -> constrói, falha depois no request
```

O `String(process.env.STRIPE_SECRET_KEY)` original só não derrubava o boot **por acidente**:
convertia `undefined` na string `"undefined"`, que é truthy. Uma "limpeza" para `?? ''` teria
derrubado a aplicação no import. Hoje há um placeholder nomeado e o comentário explicando
por que não simplificar.

### D-3 em detalhe (resolvido)

A primeira redação deste documento tratou os dois provedores como o mesmo problema
("webhook sem verificação aceita evento forjado"). **Estava impreciso**, e a diferença
é o que definiu a correção. Comportamento real com o segredo ausente:

| Provedor | Modo de falha | Gravidade real |
|---|---|---|
| **Stripe** | **Fail-closed.** `String(process.env.STRIPE_WEBHOOK_SECRET)` virava a string `"undefined"`, a verificação falhava e devolvia 400 | Média — disponibilidade: billing para de reconciliar em silêncio, sem brecha de segurança |

A correção tem **duas camadas**, porque o guard de boot sozinho não bastaria — ele impede
a *configuração* ruim, mas o caminho `skipped → processa` continuaria no código:

1. **Guard de boot** (`envSchema.superRefine` → `findProductionBlockers`): em produção, se
   o provedor está configurado, o segredo dele é obrigatório. Deploy falha nomeando a variável.
2. **Fail-closed no controller**: em produção, `mode: 'skipped'` passou a lançar
   um erro em vez de processar. Fora de produção continua passando, senão nenhum teste
   local de webhook funcionaria.

O Stripe também deixou de ler `process.env` direto — agora vai por `EnvService` (valor
validado) e devolve `STRIPE_WEBHOOK_SECRET_MISSING`, que diagnostica a configuração em vez
de reportar assinatura inválida.

### D-5 em detalhe

Anotar o retorno como `Env[K]` faz o `tsc` apontar 7 usos de variável opcional em
parâmetro `string`:

```
src/modules/integrations/infrastructure/providers/google/google-ads.provider.ts   101, 105, 123, 175, 489
src/modules/integrations/infrastructure/providers/tiktok/tiktok-ads.provider.ts   101, 104
```

**Correção de severidade:** a primeira redação disse que esses usos "alimentam chamadas OAuth
com credencial possivelmente `undefined`". É o que os **tipos** dizem, não o que acontece em
execução. Verificado depois: todo método que lê credencial chama `ensureConfigured()` antes
(que lança `PROVIDER_NOT_CONFIGURED`), e `revokeToken` faz `if (!this.isConfigured()) return`.
**Não há bug de runtime** — é lacuna de *narrowing*.

Isso rebaixou D-5 de "bug latente" para "higiene de tipos", mas **não** o tornou dispensável,
porque é o que sustenta os outros — ver "Por que a ordem D-5 → D-2 importou" acima.

**Correção aplicada:** `ensureConfigured(): void` deu lugar a `requireConfig(): Config`, que
devolve o bundle já validado com campos `string`, nos três providers de ads (Google, TikTok,
Meta). A garantia passou a fluir pelos tipos em vez de depender da convenção "chame
`ensureConfigured` primeiro". Efeitos colaterais úteis do refactor:

- `readConfig()` trata valor só com espaços como ausente — antes `'   '` contava como
  credencial configurada;
- a URL de `advertiser/get` do TikTok, que carrega `app_id`/`secret` em query string, passou a
  ser montada com `URLSearchParams` (encoding correto) e ganhou comentário de "nunca logar";
- `GOOGLE_ADS_SCOPES` em branco agora cai no default em vez de virar scope vazio.

Cobertura: `ads-provider-config.spec.ts` (23 testes) trava o comportamento do gate nos três
providers.

## Checklist de aceite do guard

- [x] Faltando um crítico em produção → boot falha nomeando a variável
- [x] Faltando um opcional → boot conclui, com log identificando a feature degradada
- [x] `NODE_ENV != production` não exige segredo de webhook
- [x] Provedor de billing não configurado não exige o segredo de webhook dele
- [x] Nenhum construtor de client lança por credencial ausente (regressão do Sprint 5) —
      `ConfigReadinessService` é `try/catch` de ponta a ponta e nunca lança
- [x] Webhook não verificável é **rejeitado** em produção, não apenas logado
- [x] D-1 … D-5 resolvidas
- [x] O boot conclui com **apenas** as 5 variáveis críticas definidas (testado)

Cobertura: `config-readiness.spec.ts` (28 testes), `env.spec.ts` (regras através do schema
real, que é o que o `EnvModule` executa). O teste do schema existe porque as funções puras passarem não prova que o
`superRefine` está plugado.
