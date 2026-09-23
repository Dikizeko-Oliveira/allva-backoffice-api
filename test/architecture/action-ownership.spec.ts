import {
  SRC_ROOT,
  importedModules,
  readSourceFiles,
} from './support/source-tree';

const sources = readSourceFiles(SRC_ROOT);

/**
 * §16.4 — **só `platform-actions` importa `AdActionGateway`.**
 *
 * Em A2-S6 o gate era mais forte: ninguém o importava, porque ele não existia. O
 * motor de recomendação produzia o **plano** e nada o executava. A2-S7 criou o
 * executor, e a regra passa da ausência para a exclusividade — a mesma
 * proteção, agora com um dono.
 *
 * O que a exclusividade compra: toda a defesa de P5 — RBAC, kill switch,
 * consentimento, revalidação, I2, teto diário, auditoria dupla — mora no
 * caminho que chama este port. Um segundo chamador não herdaria nenhuma dessas
 * guardas, e a escrita que ele fizesse seria indistinguível de uma autorizada
 * na hora de auditar.
 */
describe('§16.4 — o gateway de escrita tem um dono só', () => {
  it('nenhum módulo fora de platform-actions importa AdActionGateway', () => {
    const offenders = sources
      .filter((file) => !file.path.endsWith('.spec.ts'))
      .filter((file) => !file.path.startsWith('src/modules/platform-actions/'))
      .filter((file) =>
        importedModules(file.content).some((specifier) =>
          /ad-action\.gateway|AdActionGateway/.test(specifier),
        ),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('o port mora em platform-actions e é o único (guarda a guarda)', () => {
    // Sem esta asserção o teste acima passaria por vacuidade se o port fosse
    // renomeado — e um gate que passa porque não achou nada é um gate morto.
    const gateways = sources
      .filter((file) => /ports\/ad-action\.gateway\.ts$/.test(file.path))
      .map((file) => file.path);

    expect(gateways).toEqual([
      'src/modules/platform-actions/domain/ports/ad-action.gateway.ts',
    ]);
  });

  /**
   * A implementação de plataforma vive sob `infrastructure/providers/`, que é
   * onde P6 permite condicional por plataforma. Fora dali, um `if (platform ===
   * 'META')` no caminho de escrita seria a porta pela qual a segunda plataforma
   * entra copiando a primeira.
   */
  it('toda implementação do gateway vive em infrastructure/providers', () => {
    const offenders = sources
      .filter((file) => !file.path.endsWith('.spec.ts'))
      .filter((file) => /extends\s+AdActionGateway\b/.test(file.content))
      .filter((file) => !file.path.includes('/infrastructure/providers/'))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('recommendations não importa platform-actions (§5.3 r.5)', () => {
    const offenders = sources
      .filter((file) => file.path.startsWith('src/modules/recommendations/'))
      .flatMap((file) =>
        importedModules(file.content)
          .filter((specifier) =>
            specifier.includes('modules/platform-actions/'),
          )
          .map((specifier) => `${file.path} → ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });
});

/**
 * P3 — **toda `AdAction` tem origem declarada, e `RECOMMENDATION` sem
 * `recommendationId` é erro de schema.**
 *
 * A verificação é do lado do código porque o `CHECK` do banco cobre a linha, não
 * o caminho: o que se quer impedir é o `create` que esquece o campo, e
 * esquecimento é sintático.
 */
describe('P3 — origem declarada em toda ação', () => {
  const creators = sources.filter(
    (file) =>
      !file.path.endsWith('.spec.ts') &&
      /prisma\.adAction\.create|tx\.adAction\.create/.test(file.content),
  );

  it('existe pelo menos um criador de ação (guarda a guarda)', () => {
    expect(creators.length).toBeGreaterThan(0);
  });

  /**
   * O gate mira **esquecimento**, e esquecimento é sintático: um `create` sem a
   * chave `origin`.
   *
   * Ele exigia literal entre aspas, o que valia enquanto o único criador era o
   * planejador de `recommendations` — que só produz `RECOMMENDATION`. A2-S7
   * trouxe um criador cuja origem é legitimamente variável: a mesma transação
   * grava `USER_DIRECT`, `RECOMMENDATION` e `REVERT` conforme quem pediu. Exigir
   * literal ali forçaria três caminhos duplicados só para satisfazer o teste —
   * e três cópias da mesma transação é uma garantia pior, não melhor.
   *
   * O que substitui a força perdida: `EnqueueActionInput.origin` é uma união
   * fechada e **não opcional**, então omiti-la não compila.
   */
  it('todo criador de AdAction declara origin', () => {
    const offenders = creators
      .filter((file) => !/\borigin:\s*\S/.test(file.content))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('quem declara origin RECOMMENDATION passa recommendationId junto', () => {
    // Os dois campos viajam no mesmo literal. Um `create` com
    // `origin: 'RECOMMENDATION'` e sem o id produziria a ação órfã que P3 existe
    // para impedir — e o banco só a recusaria se houvesse `CHECK`, que não há.
    const offenders = creators
      .filter((file) => /origin:\s*'RECOMMENDATION'/.test(file.content))
      .filter((file) => !/recommendationId:/.test(file.content))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('parâmetros de ação passam pelo schema por tipo (G15)', () => {
    // Um `create` que grave `parameters` sem validar aceitaria
    // `ADJUST_AD_SET_BUDGET` sem `dailyBudget`, e o erro apareceria na
    // plataforma — movendo, ou não movendo, dinheiro real.
    const offenders = creators
      .filter((file) => !/parseActionParameters\(/.test(file.content))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
