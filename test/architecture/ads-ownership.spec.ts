import {
  AD_FIELD_OWNERSHIP,
  DENORMALIZED_READ_FIELDS,
  OWNED_AD_FIELDS,
  ownerOf,
} from '../../src/modules/ads/domain/ad-field-ownership';
import {
  SRC_ROOT,
  importedModules,
  readSourceFiles,
} from './support/source-tree';

const sources = readSourceFiles(SRC_ROOT);

/**
 * Os módulos de inteligência e de escrita. `ads` é a **base do grafo** (§5.3
 * r.1) e não pode depender de nenhum deles: se depender, a tela principal passa
 * a exigir que o detector e o motor de recomendação existam para renderizar.
 */
const DOWNSTREAM_MODULES = [
  'ad-scoring',
  'waste',
  'recommendations',
  'creative-lab',
  'platform-actions',
  'sync',
  'analytics',
  'reports',
];

describe('ads é a base do grafo (§5.3)', () => {
  it('não importa nenhum módulo de inteligência nem de escrita', () => {
    const offenders = sources
      .filter((file) => file.path.startsWith('src/modules/ads/'))
      .flatMap((file) =>
        importedModules(file.content)
          .filter((specifier) =>
            DOWNSTREAM_MODULES.some((module) =>
              specifier.includes(`modules/${module}/`),
            ),
          )
          .map((specifier) => `${file.path} → ${specifier}`),
      )
      // `ad-scoring` é a exceção **declarada** de D2: `ads` consome o port de
      // LEITURA `AdScoreReader` e o modelo público do score, nunca um serviço de
      // cálculo. Importar o contrato é o que a decisão autoriza; importar o
      // serviço é o que ela proíbe, e o teste abaixo cobra isso.
      //
      // `contracts/` e `ports/` são pastas diferentes porque são coisas
      // diferentes: um port é token de injeção e nasce `abstract class` (§16.6);
      // o modelo do score — quais componentes existem, com que peso, sobre que
      // sinais — é **dado**, e `ads` precisa dele para declarar
      // `meta.coverageByPlatform` sem tocar na aritmética que compõe o número.
      .filter(
        (entry) =>
          !entry.includes('ad-scoring/domain/ports/') &&
          !entry.includes('ad-scoring/domain/contracts/'),
      );

    expect(offenders).toEqual([]);
  });

  it('consome apenas o port de leitura de ad-scoring, nunca o cálculo', () => {
    const offenders = sources
      .filter((file) => file.path.startsWith('src/modules/ads/'))
      .flatMap((file) =>
        importedModules(file.content)
          .filter(
            (specifier) =>
              specifier.includes('modules/ad-scoring/') &&
              !specifier.includes('/domain/ports/') &&
              !specifier.includes('/domain/contracts/'),
          )
          .map((specifier) => `${file.path} → ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });
});

/**
 * D3 — **rota ≠ módulo**.
 *
 * O prefixo `/ads` é compartilhado com módulos que chegam depois. Sem a regra, o
 * prefixo comum convida `ads` a importar `platform-actions`, e a base do grafo
 * passa a depender da ponta.
 */
describe('rota ≠ módulo (D3)', () => {
  const adsControllers = sources.filter(
    (file) =>
      file.path.startsWith('src/modules/ads/') &&
      file.path.endsWith('.controller.ts') &&
      !file.path.endsWith('.spec.ts'),
  );

  it('encontra os controllers de ads (guarda a guarda)', () => {
    expect(adsControllers.length).toBeGreaterThanOrEqual(2);
  });

  it('nenhum controller de ads declara verbo de escrita (P1)', () => {
    // P1: a Allva não origina mídia. A ausência é verificada no código, não
    // prometida em documentação — `POST /ads/{id}/actions` nasce em
    // `platform-actions`, com o dono que executa a escrita.
    const offenders = adsControllers
      .filter((file) => /@(Post|Put|Patch|Delete)\(/.test(file.content))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('nenhum controller de contexto expõe escrita de campanha (§7.4)', () => {
    const context = sources.find((file) =>
      file.path.endsWith('ad-context.controller.ts'),
    );

    expect(context).toBeDefined();
    // As rotas do v1 removidas por violarem P1 não voltam por descuido.
    expect(context!.content).not.toMatch(/@Post\(|@Delete\(|@Patch\(/);
    expect(context!.content).not.toContain('generate-title');
  });

  /**
   * Os controllers que servem `/ads` **de fora** de `ads` — hoje `waste` e
   * `recommendations`, em A2-S7 também `platform-actions`.
   */
  const foreignAdsControllers = sources.filter(
    (file) =>
      !file.path.startsWith('src/modules/ads/') &&
      file.path.endsWith('.controller.ts') &&
      /@Controller\(\s*'\/api\/v1\/ads'\s*\)/.test(file.content),
  );

  it('encontra os controllers de /ads fora de ads (guarda a guarda)', () => {
    expect(foreignAdsControllers.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * **O modo de falha do padrão é o silêncio.** Rota ≠ módulo funciona porque o
   * controller mora no dono do dado — e um controller que ninguém registrou não
   * levanta erro nenhum: o grafo de injeção resolve, `tsc` passa, a suíte passa,
   * e a rota simplesmente não existe. O cliente recebe 404 sem que nada tenha
   * falhado em lugar algum.
   */
  it('todo controller de /ads fora de ads está registrado em um módulo', () => {
    const modules = sources.filter((file) => file.path.endsWith('.module.ts'));

    const offenders = foreignAdsControllers
      .filter((controller) => {
        const className = /export class (\w+)/.exec(controller.content)?.[1];
        if (!className) return true;

        return !modules.some((module) =>
          new RegExp(`controllers:\\s*\\[[^\\]]*\\b${className}\\b`, 's').test(
            module.content,
          ),
        );
      })
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it('ads não serve rota de segmento que pertence a outro módulo', () => {
    // `waste`, `recommendations` e `actions` são caminhos sob `/ads` cujo dono é
    // outro módulo. Reintroduzi-los aqui — mesmo como stub que devolve 503 —
    // recria a colisão que a saída de A2-S5 e A2-S7 desfez.
    const offenders = adsControllers
      .filter((file) =>
        /@Get\(\s*'\/:id\/(waste|recommendations|actions)/.test(file.content),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});

/**
 * §5.4 — propriedade de escrita sobre as colunas de `ads`.
 *
 * Cada grupo tem um dono; os demais leem. Sem isso, `observedStatus` e
 * `desiredStatus` acabam escritos pelo mesmo caminho e a reconciliação reporta
 * drift sobre divergência que o próprio produto criou.
 */
describe('propriedade de escrita (§5.4)', () => {
  it('todo campo denormalizado tem dono declarado', () => {
    const orphans = DENORMALIZED_READ_FIELDS.filter(
      (field) => ownerOf(field) === null,
    );

    expect(orphans).toEqual([]);
  });

  it('nenhum campo tem dois donos', () => {
    const seen = new Map<string, string>();
    const duplicated: string[] = [];

    for (const group of AD_FIELD_OWNERSHIP) {
      for (const field of group.fields) {
        const previous = seen.get(field);
        if (previous && previous !== group.owner) duplicated.push(field);
        seen.set(field, group.owner);
      }
    }

    expect(duplicated).toEqual([]);
  });

  it('os dois estados têm donos diferentes — é a base de I3', () => {
    expect(ownerOf('observedStatus')).toBe('sync');
    expect(ownerOf('desiredStatus')).toBe('platform-actions');
  });

  it('dataMaturity é do sync, não do ad-scoring', () => {
    // Ela deriva da janela de atribuição da conta contra a data do dado — é
    // propriedade da observação. Se o scoring a escrevesse, a detecção
    // dependeria do scoring para decidir se pode rodar (§8.9).
    expect(ownerOf('dataMaturity')).toBe('sync');
  });

  it('o módulo ads não escreve nenhum campo com dono', () => {
    // `ads` lê o agregado; quem escreve é o dono de cada grupo. Um `update`
    // dentro de `ads` seria a primeira brecha na regra.
    const writes = sources
      .filter(
        (file) =>
          file.path.startsWith('src/modules/ads/') &&
          !file.path.endsWith('.spec.ts'),
      )
      .filter((file) =>
        /prisma\.ad\.(update|create|upsert|delete)/.test(file.content),
      )
      .map((file) => file.path);

    expect(writes).toEqual([]);
  });

  it('cobre os oito grupos de §5.4', () => {
    // O oitavo é `analysis-scope`, dono de `analysisEligibleAt`: a régua de
    // quantos anúncios o plano manda analisar.
    expect(AD_FIELD_OWNERSHIP).toHaveLength(8);
    expect(OWNED_AD_FIELDS.length).toBeGreaterThan(20);
  });
});

/**
 * §16.7 — toda query de inteligência filtra `organizationId`.
 *
 * A verificação é textual de propósito: o que se quer impedir é a consulta que
 * *esquece* o filtro, e esquecimento é sintático.
 */
describe('tenancy (§16.7)', () => {
  it('toda consulta do repositório de ads carrega organizationId', () => {
    const repositories = sources.filter(
      (file) =>
        file.path.startsWith('src/modules/ads/infrastructure/database/') &&
        !file.path.endsWith('.spec.ts'),
    );

    expect(repositories.length).toBeGreaterThan(0);

    for (const file of repositories) {
      const queries = [
        ...file.content.matchAll(
          /prisma\.\w+\.(findMany|findFirst|count|groupBy|aggregate)\(\{([\s\S]*?)\n {4}\}\)/g,
        ),
      ];

      for (const [, method, body] of queries) {
        // `toWhere`/`where` montados fora do literal contam: o que não pode é a
        // consulta que não menciona organização em lugar nenhum.
        const scoped =
          /organizationId/.test(body) ||
          /this\.toWhere\(/.test(body) ||
          /where,/.test(body);

        expect({ file: file.path, method, scoped }).toMatchObject({
          scoped: true,
        });
      }
    }
  });
});
