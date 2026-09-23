/**
 * Jest config for unit tests (co-located `*.spec.ts` under `src/`) and for the
 * conformance harness under `test/architecture/` (A2-S0).
 * Path aliases mirror tsconfig ("@/..." and "src/...").
 * E2E/integration tests (requiring a test DB) still need their own config —
 * see PLAN.md Sprint 6 for the CI + test-DB wiring.
 */
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  /**
   * `src/` para os testes co-localizados e `test/` para o harness de
   * conformidade de A2-S0 (arquitetura §16.6, achado D8). O harness precisa
   * enxergar o repositório inteiro — `prisma/schema.prisma`, `eslint-rules/`,
   * a árvore de módulos —, então não pode viver dentro de `src/` como se fosse
   * teste de uma unidade.
   */
  roots: ['<rootDir>', '<rootDir>/../test'],
  testRegex: '.*\\.spec\\.ts$',
  /**
   * A suíte principal roda **sem infraestrutura**. Os specs que exigem Postgres
   * ou Redis vivem em `test/integration/` e rodam em `pnpm test:integration`,
   * que é o que o job `integration` do CI executa com os containers de pé.
   *
   * Antes de A2-S9 eles rodavam aqui e **pulavam em silêncio** quando não havia
   * banco — verdes por ausência. Separá-los é o que torna o pulo impossível: ou
   * o job de integração roda com banco, ou ele falha.
   */
  testPathIgnorePatterns: [
    '/node_modules/',
    'test/integration/',
    // Mora em `test/architecture/` porque é gate de schema, e depende de banco
    // porque lê `information_schema`. `pnpm test:integration` o inclui pelo nome.
    'schema-gates-db',
  ],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^src/(.*)$': '<rootDir>/$1',
    /**
     * O cliente Prisma gerado vive fora de `src/`, e `rootDir` é `src/`.
     *
     * Até A2-S7 nenhum teste precisou disto: todo `import { Prisma }` do
     * repositório usava o namespace **só como tipo**, e o TypeScript elide a
     * importação inteira ao emitir — ela nunca chegava ao resolvedor do Jest. O
     * primeiro uso como **valor** (`instanceof
     * Prisma.PrismaClientKnownRequestError`, que é como se distingue uma
     * violação de unicidade de um erro qualquer) quebrou a montagem do grafo,
     * e não porque o código estava errado.
     */
    '^generated/(.*)$': '<rootDir>/../generated/$1',
  },
  collectCoverageFrom: ['**/*.(t|j)s', '!**/*.module.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  // `json-summary` é o que o passo "Coverage summary" do CI lê para publicar os
  // números no resumo do job; `lcov` fica para inspeção local em HTML.
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
  testEnvironment: 'node',

  /**
   * Coverage gate (PLAN.md Sprint 5.5, P-1). Two tiers, on purpose:
   *
   * 1. `global` is an anti-regression floor, not a target. It sits just under
   *    the measured baseline so it blocks cobertura caindo without blocking
   *    anything today. Raise it at the end of every sprint.
   * 2. The per-directory groups are the critical paths — money, permission and
   *    AI routing. They already have real coverage, so a regression there
   *    should hurt.
   *
   * Jest SUBTRACTS every path group below from the `global` pool, so `global`
   * measures the *remaining* files only — which is always lower than the number
   * reported for the whole repo, because the carved-out directories are precisely
   * the well-covered ones. `scripts/ci/coverage-summary.js` prints both side by
   * side so the difference is never mistaken for a regression.
   *
   * Baseline medido após a migração de billing para Stripe (492 testes, 50 suítes),
   * pós carve-out:
   *   global   statements 18,43% · branches 10,54% · functions 15,35% · lines 18,57%
   *   ai/infrastructure/routing        92,59 · 89,29 · 96,43 · 93,53
   *   shared/infrastructure/security   97,56 · 85,71 · 100,00 · 97,44
   *   subscriptions/access/domain      85,29 · 75,00 · 100,00 · 84,85
   *   shared/infrastructure/config     97,98 · 97,22 · 92,59 · 97,85
   *   modules/alerts                   90,77 · 76,06 · 83,78 · 90,48  (era 0%)
   *   modules/audit                    72,92 · 66,67 · 70,59 · 75,00  ← novo (era 22,9%)
   *
   * Ratchet: 10,98 (fim do Sprint 5) → 12,21 (Sprint 5.5) → 14,14 → 15,32 → 15,75 →
   * 16,25 → 16,54 → 17,84 → 18,43. O salto de 17,84 é `stripe.service.ts`, de 2,9%
   * para 78%: rede montada ANTES da migração de billing, e não depois.
   *
   * A2-S0 (2026-07-30): 19,1 → 20,1, medido em 20,2 / 12,0 / 17,05 / 20,17. A
   * infraestrutura transversal entrou com cobertura quase total e virou grupo
   * próprio abaixo, o que **reduz** o pool global — o número subir mesmo assim
   * é efeito dos testes novos, não da mudança de denominador.
   *
   * A2-S1 (2026-07-31): 20,1 → 20,5, medido em 20,57 / 14,99 / 16,37 / 20,42
   * (repo inteiro: 29,1 / 25,8 / 24,8 / 28,9). Duas forças em direções opostas:
   * o parking tirou ~5 mil linhas de motores v1 sem teste — waste, recomendações,
   * otimização criativa, ingest, `campaigns` inteiro —, o que **encolhe o
   * denominador**; e os dois grupos novos de domínio puro (dinheiro e token
   * bucket) saem do pool global por terem piso próprio, o que o abaixa de volta.
   * O salto de branches (12 → 15) é o efeito real do primeiro.
   *
   * A2-S4 (2026-08-02): 52,7 → 55 no pool global, com `ad-scoring/domain`
   * saindo dele como grupo próprio (94 / 88,7 / 96,9 / 95,6). No repositório
   * inteiro: 57,8 → 61,4 de statements e 29,4 → **35,4** de branches. A linha de
   * branches é a que importa aqui, e o salto vem de onde deveria: as decisões do
   * score — composição com prior, cobertura relativa, corte por descontinuidade,
   * disponibilidade de componente — são todas ramos, e cada um deles decide o
   * que o produto afirma sobre a mídia de alguém.
   *
   * A2-S6 (2026-08-02): 55,4 → 55,5 no pool global, com
   * `recommendations/domain` saindo dele como grupo próprio
   * (88,2 / 74,5 / 100 / 92,6). No repositório inteiro: 63 → 63,2 de statements
   * e 37,2 → **37,6** de branches.
   *
   * O carve-out repetiu o padrão de A2-S5 e a resposta foi a mesma: tirar do
   * pool um diretório bem coberto o abaixa, e a saída não é baixar o piso nem
   * criar um grupo frouxo para o resto do módulo. Foram dois arquivos de teste —
   * o serviço de geração (os nove passos de §9.4) e o `apply` (o 409 de premissa
   * vencida, que é gate declarado do sprint) — porque os dois eram código de
   * decisão sem nenhuma verificação.
   *
   * A2-S5 (2026-08-02): 55 → 55,4 no pool global, com `waste/domain` saindo
   * dele como grupo próprio (91,6 / 73,6 / 87,9 / 96,9). No repositório inteiro:
   * 61,4 → 62,4 de statements e 35,4 → **36,6** de branches.
   *
   * **O pool global oscila ~0,5 ponto entre configurações de suíte, e o gate
   * precisa ficar abaixo do piso — não no pico.** Duas medições do mesmo código
   * deram 55,98 e 55,60; corridas consecutivas da segunda são idênticas, então
   * não é ruído de execução: é atribuição. `application-graph.spec.ts` monta o
   * grafo de injeção inteiro e é ele que cobre as linhas de declaração e
   * construtor de quase todo arquivo — quanto disso conta como "coberto" depende
   * de qual worker carregou o arquivo primeiro, e isso muda quando a lista de
   * suítes muda. Um gate cravado no pico reprova no commit seguinte sem que
   * ninguém tenha piorado nada, e é assim que um time aprende a ignorar o gate.
   * Ratchet abaixo do menor valor observado, sempre.
   *
   * O carve-out quase não passou, e o quase é a informação: tirar do pool um
   * diretório bem coberto o **abaixa**, e a primeira medição depois de carvar
   * `waste/domain` deixou o global em 21,99 contra um piso de 22,2. A saída não
   * foi baixar o piso — seria desfazer o catraca — nem criar um grupo frouxo
   * para o resto de `waste/`, que só lavaria o número. Foram dois arquivos de
   * teste: quatro dos dez detectores só tinham cobertura de **serem recusados**
   * pelo portão, nunca de disparar, e a superfície de leitura não tinha nenhuma
   * verificação do contrato de procedência que P7 exige dela.
   *
   * A2-S3 (2026-08-01): 52 → 52,7 no pool global, e o pool **encolheu** — o
   * domínio de `sync` virou grupo próprio (96 / 92 / 100 / 97) e saiu dele. Os
   * números do repositório inteiro subiram mais: 52 → 57,8 de statements e
   * 16,3 → 29,2 de branches, e é a segunda que mede comportamento verificado.
   * O motor de sync inteiro entrou coberto pelas decisões que ele toma — guarda
   * de arquivamento, guarda de recência, maturidade, escada de drift e takeover
   * de janela —, não pelo caminho feliz do ingest.
   *
   * A2-S2 (2026-07-31): 20,5 → 52. **Este salto não é cobertura nova.**
   * `test/architecture/application-graph.spec.ts` monta o grafo de injeção
   * inteiro, e instanciar um provider marca como cobertas as linhas de
   * declaração e de construtor de quase todo arquivo do `src/`. O número deixou
   * de ser comparável com o dos sprints anteriores: 52% aqui não significa o
   * mesmo que 52% significaria antes.
   *
   * Mantê-lo assim mesmo preserva o que o gate existe para fazer — **impedir
   * regressão** —, e o salto de branches (14,9 → 16,3, um ponto e meio) mostra
   * o que de fato foi testado a mais. É a linha de branches que continua sendo
   * o sinal honesto de comportamento verificado; statements virou, em boa
   * parte, medida de "quanto do grafo monta".
   *
   * A2-S9 (2026-08-03): 55,5 → 57,4 no pool global, e **branches 22,2 → 26,4** —
   * o maior salto de branches desde A2-S3. Medido em 57,95 / 26,95 / 36,38 /
   * 57,09; a catraca fica abaixo, como sempre. No repositório inteiro:
   * 63,2 → 64,3 de statements e 37,6 → **39,7** de branches.
   *
   * **Recalibrado para baixo ao separar a suíte de integração** (2026-08-04):
   * 57,4 → 57 e 26,4 → 25,7. Os sete specs que tocam banco saíram do run de
   * cobertura, e com eles a contribuição que davam a repositórios Prisma e
   * controllers — o E2E boota o `AppModule` inteiro.
   *
   * **O número desceu e a verificação subiu**, que é a leitura honesta: antes
   * eles rodavam aqui e **pulavam em silêncio** sem banco, somando cobertura na
   * máquina de quem tinha Postgres e zero no CI. Agora rodam no job
   * `integration`, com banco obrigatório, e falham se pularem. Cobertura medida
   * por teste que só roda às vezes é cobertura que não protege.
   *
   * **A primeira tentativa cravou 59,5 e reprovou.** `scripts/ci/coverage-summary.js`
   * reportava 60,1 porque a lista de carve-outs dele estava desatualizada desde
   * A2-S5: `waste/domain` e `recommendations/domain` viraram grupos no Jest e
   * nunca entraram no script, que por isso subtraía menos do pool e devolvia um
   * número dois pontos alto. Corrigido lá — é o próprio comentário do script que
   * diz que ele existe para a diferença nunca ser confundida com regressão.
   *
   * O salto vem de onde deveria, e a razão é a mesma que fez `sync/domain` e
   * `waste/domain` virarem grupos próprios: A2-S9 é quase inteiramente decisão.
   * `outcome-measurement.ts` decide o que o produto **afirma sobre o próprio
   * acerto** — o sinal do delta por tipo, o corte de cobertura abaixo do qual não
   * há veredito, os confounders que descontam a confiança —, e cada um desses é
   * um ramo. `retention-policy.ts` decide o que o produto **deixa de saber**, e é
   * a única política do sistema sem desfazer.
   *
   * As duas ficam no pool global de propósito, sem carve-out: um grupo novo o
   * abaixaria (é o padrão documentado acima), e o que elas cobrem já está medido
   * pelos pisos de `recommendations/domain` e `sync/domain`, que as contêm.
   *
   * Branch/function numbers are set below the named statement target where the
   * real branch coverage is lower — a flat "90 em tudo" would nascer vermelho.
   */
  coverageThreshold: {
    // Ratchet: raised each sprint, always just under the measured value so the
    // gate blocks a regression without blocking today's work. Measured
    // 2026-07-26 at 19,36 / 10,74 / 16,20 / 19,36 — *after* carving out the
    // Stripe webhook below, which is why it reads lower than the 18,43 baseline
    // suggests: removing a now-100% file from the pool lowers what remains.
    global: {
      statements: 57,
      branches: 25.7,
      functions: 35.1,
      lines: 56.1,
    },
    './src/modules/ai/infrastructure/routing/': {
      statements: 85,
      branches: 80,
      functions: 90,
      lines: 85,
    },
    './src/shared/infrastructure/security/': {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
    './src/modules/subscriptions/access/domain/': {
      statements: 80,
      branches: 70,
      functions: 90,
      lines: 80,
    },
    // Sprint 6 / Ops readiness: this is the boot guard. A regression here means a
    // production deploy can come up without a verifiable billing webhook, so it
    // belongs with the other paths that carry money and permission.
    './src/shared/infrastructure/config/': {
      statements: 90,
      branches: 90,
      functions: 85,
      lines: 90,
    },
    // Sprint 6 / M-2. Named as a critical path because this module now decides
    // whether to send mail: a regression is either an alert nobody receives or a
    // user emailed against their stated preference. Went 0% -> 90,8% with the
    // feature, per the "name the sprint's modules" decision.
    './src/modules/alerts/': {
      statements: 85,
      branches: 72,
      functions: 80,
      lines: 85,
    },
    // Sprint 6 / M-5. The audit trail is the record of who did what to whose data;
    // a regression here is evidence that stops being written. Went 22,9% -> 72,9%.
    './src/modules/audit/': {
      statements: 70,
      branches: 62,
      functions: 68,
      lines: 70,
    },
    // A2-S0 / infraestrutura transversal. Nomeada como caminho crítico porque
    // é pré-requisito declarado de todo sprint seguinte (§II.1): os 22 eventos
    // e o envelope de §7.0 são consumidos por `sync`, `ad-scoring`, `waste`,
    // `recommendations` e `platform-actions`. Uma regressão aqui não quebra um
    // módulo — quebra a cadeia de rastreabilidade de todos eles, e em silêncio,
    // porque evento perdido não levanta exceção em lugar nenhum.
    './src/shared/domain/events/': {
      statements: 70,
      branches: 90,
      functions: 90,
      lines: 70,
    },
    './src/shared/infrastructure/events/': {
      statements: 95,
      branches: 50,
      functions: 90,
      lines: 95,
    },
    './src/shared/infrastructure/http/envelope/': {
      statements: 95,
      branches: 75,
      functions: 95,
      lines: 95,
    },
    './src/shared/infrastructure/http/errors/': {
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    },
    './src/shared/infrastructure/http/pagination/': {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
    './src/shared/infrastructure/context/': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    // A2-S1 / dinheiro e orçamento de chamadas. As duas são matemática pura com
    // consequência direta: um erro de arredondamento em `currency/domain` não
    // quebra nada visivelmente — só faz o total da tela não fechar com o do
    // banco —, e um erro no token bucket faz a plataforma cortar a conta inteira,
    // inclusive as escritas que movem dinheiro.
    './src/modules/currency/domain/': {
      statements: 90,
      branches: 88,
      functions: 95,
      lines: 92,
    },
    './src/modules/platform-clients/domain/': {
      statements: 90,
      branches: 88,
      functions: 95,
      lines: 90,
    },
    // A2-S3 / as decisões do sync. Nomeado como caminho crítico porque duas
    // funções puras daqui decidem sobre os dados do usuário: a guarda de
    // arquivamento (§8.2) escolhe se "não vimos" pode virar "não existe mais", e
    // a guarda de recência (§8.4.1) escolhe se uma observação pode sobrescrever
    // uma intenção em voo. Uma regressão em qualquer das duas é silenciosa e
    // destrutiva — a primeira arquiva anúncios ativos, a segunda faz o produto
    // alertar sobre um drift que ele mesmo fabricou.
    './src/modules/sync/domain/': {
      statements: 96,
      branches: 92,
      functions: 100,
      lines: 97,
    },
    // A2-S4 / o número que o produto chama de AI Score. Nomeado como caminho
    // crítico pela mesma razão de `currency/domain`: é matemática pura com
    // consequência direta e silenciosa. Um erro na composição não quebra nada —
    // só faz o produto afirmar sobre a mídia do usuário com confiança que não
    // tem —, e a descontinuidade de série é o que impede uma enxurrada de
    // alertas de queda no dia em que um sinal novo passa a ser coletado.
    './src/modules/ad-scoring/domain/': {
      statements: 93,
      branches: 88,
      functions: 96,
      lines: 95,
    },
    // A2-S5 / o que o produto afirma ser desperdício do usuário. Nomeado como
    // caminho crítico pela mesma razão de `sync/domain` e `ad-scoring/domain`:
    // são funções puras cuja regressão é silenciosa e cara. Três em particular —
    // a evidência mínima (P7), o `max` de somabilidade (§10.6) e a classificação
    // de resolução (§10.7 passo 7) — decidem, respectivamente, se o produto
    // afirma sem base, se ele infla o número de capa contando o mesmo gasto duas
    // vezes, e se uma noite de indisponibilidade resolve o desperdício aberto de
    // uma organização inteira como "condição cessou".
    //
    // Branches é o número mais baixo do grupo (73,6 medido) e o mais honesto: um
    // detector é uma árvore de cortes, e cada ramo não coberto é uma fronteira
    // sobre a qual ninguém verificou o que o produto diz.
    './src/modules/waste/domain/': {
      statements: 91,
      branches: 72,
      functions: 86,
      lines: 95,
    },
    // A2-S6 / o plano que o produto propõe ao usuário. Nomeado como caminho
    // crítico pela razão mais direta de todas: aqui mora a única recomendação
    // que **aumenta** gasto, e as seis guardas que a retêm. Um `>=` invertido
    // numa delas não quebra nada visivelmente — só faz o produto mandar alguém
    // investir mais num criativo em fim de vida.
    //
    // As outras duas decisões silenciosas do grupo: o conflito por alvo (§9.4
    // passo 4), sem o qual duas escritas opostas na mesma entidade viram "a
    // última vence", e a revalidação de premissa (§9.5 passo 1), que é o que
    // separa um copiloto de um gerador de acidentes.
    './src/modules/recommendations/domain/': {
      statements: 87,
      branches: 73,
      functions: 98,
      lines: 92,
    },
    // The code that turns a Stripe payment into an active subscription. It was
    // the one money path never named here, and it sat at 67,2% statements /
    // 38,2% branches — the branch number mattering most, because almost every
    // branch is a "Stripe sent a shape we did not expect" case. Now 100 / 97,1.
    './src/modules/subscriptions/application/use-cases/handle-stripe-webhook.usecase.ts':
      {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
  },
};
