import { ATTRIBUTION_RULE, attribute } from './attribution';
import {
  BENCHMARK_FALLBACK_MULTIPLIER,
  DEFAULT_DETECTOR_PROFILE,
  DEFAULT_DETECTOR_THRESHOLDS,
  resolveProfile,
  toThresholdsJson,
} from './detector-profile';
import { requiredMaturity } from './evidence';
import { MINIMUM_MATURITY_BY_FINDING } from 'src/modules/sync/domain/data-maturity';
import { FINDING_TYPES } from './contracts/finding-catalog';
import { aggregate } from './test-support/aggregate.fixture';
import { score } from './test-support/aggregate.fixture';

/**
 * §10.4 — os limiares saem do corpo dos detectores e viram **configuração
 * versionada**.
 *
 * É isso que torna P7 verificável ("por que este anúncio foi marcado?") e P8
 * possível (calibrar sem deploy, comparar configurações lado a lado).
 */
describe('perfil de detector', () => {
  it('o padrão é serializável pelo schema versionado (E1, G15)', () => {
    const json = toThresholdsJson(DEFAULT_DETECTOR_THRESHOLDS);

    expect(json.schemaVersion).toBe(1);
    expect(Object.keys(json.detectors).sort()).toEqual(
      [...FINDING_TYPES].sort(),
    );
  });

  it('calibrar UM limiar preserva os outros nove', () => {
    // Sem o merge por chave, publicar um perfil com um detector dentro apagaria
    // os demais — e o produto pararia de detectar nove tipos por causa de um
    // ajuste em um.
    const profile = resolveProfile({
      version: 'org-tuning-v1',
      organizationId: 'org-1',
      thresholds: {
        schemaVersion: 1,
        detectors: {
          HIGH_CPA: {
            values: { cpaMultiple: 4, fallbackMultiplier: 2 },
            minimumEvidence: { days: 5, conversions: 5 },
            requiresMaturity: 'MATURE',
          },
        },
      },
    });

    expect(profile.thresholds.HIGH_CPA.values.cpaMultiple).toBe(4);
    expect(profile.thresholds.HIGH_CPA.minimumEvidence.conversions).toBe(5);
    // Os outros continuam nos valores do padrão global.
    expect(profile.thresholds.ZERO_CONVERSIONS).toEqual(
      DEFAULT_DETECTOR_THRESHOLDS.ZERO_CONVERSIONS,
    );
    expect(profile.version).toBe('org-tuning-v1');
  });

  it('valores parciais dentro de um detector mesclam sobre o padrão', () => {
    const profile = resolveProfile({
      version: 'org-tuning-v1',
      organizationId: 'org-1',
      thresholds: {
        schemaVersion: 1,
        detectors: {
          ZERO_CONVERSIONS: {
            values: { minSpendBase: 500 },
            minimumEvidence: { days: 5, spendBase: 500 },
            requiresMaturity: 'MATURE',
          },
        },
      },
    });

    expect(profile.thresholds.ZERO_CONVERSIONS.values).toMatchObject({
      minSpendBase: 500,
      // Não declarado pela organização: continua vindo do padrão.
      medianCpaMultiple: 3,
      fallbackMultiplier: BENCHMARK_FALLBACK_MULTIPLIER,
    });
  });

  it('perfil ilegível cai para o padrão E declara a versão padrão', () => {
    // Gravar `detectorProfileVersion` de um perfil que **não foi aplicado**
    // mentiria na procedência do achado — e a procedência é a única forma de
    // responder "por que este anúncio foi marcado?".
    const profile = resolveProfile({
      version: 'quebrado-v9',
      organizationId: 'org-1',
      thresholds: { isto: 'não é um perfil' },
    });

    expect(profile).toBe(DEFAULT_DETECTOR_PROFILE);
    expect(profile.version).toBe(DEFAULT_DETECTOR_PROFILE.version);
  });

  it('tipo desconhecido no perfil é ignorado, não cria detector', () => {
    const profile = resolveProfile({
      version: 'v1',
      organizationId: null,
      thresholds: {
        schemaVersion: 1,
        detectors: {
          TIPO_INVENTADO: {
            values: { x: 1 },
            minimumEvidence: { days: 1 },
            requiresMaturity: 'MATURE',
          },
        },
      },
    });

    expect(Object.keys(profile.thresholds).sort()).toEqual(
      [...FINDING_TYPES].sort(),
    );
  });
});

/**
 * §8.9 é **piso**, não sugestão.
 *
 * O perfil é configuração por organização e pode endurecer o corte; não pode
 * afrouxá-lo. Deixar a configuração baixá-lo poria a proteção mais destrutiva do
 * catálogo — não pausar anúncio que converteu — atrás de um campo `Json`.
 */
describe('maturidade mínima como piso (§8.9)', () => {
  it('o padrão nunca contradiz a tabela normativa do sync', () => {
    for (const [type, normative] of Object.entries(
      MINIMUM_MATURITY_BY_FINDING,
    )) {
      expect(
        DEFAULT_DETECTOR_THRESHOLDS[
          type as keyof typeof DEFAULT_DETECTOR_THRESHOLDS
        ].requiresMaturity,
      ).toBe(normative);
    }
  });

  it('configuração não consegue afrouxar o piso', () => {
    const permissive = resolveProfile({
      version: 'v1',
      organizationId: 'org-1',
      thresholds: {
        schemaVersion: 1,
        detectors: {
          ZERO_CONVERSIONS: {
            values: {},
            minimumEvidence: { days: 5 },
            // A organização pede `IMMATURE`. §8.9 exige `MATURE`.
            requiresMaturity: 'IMMATURE',
          },
        },
      },
    });

    expect(requiredMaturity('ZERO_CONVERSIONS', permissive)).toBe('MATURE');
  });

  it('mas consegue endurecê-lo', () => {
    const strict = resolveProfile({
      version: 'v1',
      organizationId: 'org-1',
      thresholds: {
        schemaVersion: 1,
        detectors: {
          LOW_CTR: {
            values: {},
            minimumEvidence: { days: 3 },
            requiresMaturity: 'MATURE',
          },
        },
      },
    });

    // §8.9 pede `SETTLING` para `LOW_CTR`; a organização pediu mais.
    expect(requiredMaturity('LOW_CTR', strict)).toBe('MATURE');
  });
});

/**
 * §10.3 — o determinismo da atribuição é o que mantém o fingerprint estável.
 *
 * Sem ele, o mesmo problema geraria um item novo a cada ciclo, `occurrences`
 * nunca passaria de 1, e a deduplicação deixaria de funcionar **sem nada quebrar
 * visivelmente**.
 */
describe('atribuição determinística', () => {
  const ads = ['c', 'a', 'b'].map((id) => aggregate({ adId: id }));

  it('recai sobre o menor aiScore, com os demais em relatedAdIds', () => {
    const scores = new Map([
      ['a', score({}, 80)],
      ['b', score({}, 20)],
      ['c', score({}, 50)],
    ]);

    const result = attribute(ads, scores);

    expect(result).toEqual({
      adId: 'b',
      relatedAdIds: ['a', 'c'],
      rule: ATTRIBUTION_RULE,
    });
  });

  it('empate de score decide pelo menor id', () => {
    const scores = new Map(
      ['a', 'b', 'c'].map((id) => [id, score({}, 50)] as const),
    );

    expect(attribute(ads, scores)?.adId).toBe('a');
  });

  it('anúncio sem score nunca é o escolhido enquanto houver um pontuado', () => {
    // Atribuir a um anúncio sem score seria escolher pela **ausência** de
    // informação, existindo informação ao lado.
    const scores = new Map([['c', score({}, 90)]]);

    expect(attribute(ads, scores)?.adId).toBe('c');
  });

  it('sem score nenhum, o menor id decide — e continua determinístico', () => {
    expect(attribute(ads, new Map())?.adId).toBe('a');
    expect(attribute([...ads].reverse(), new Map())?.adId).toBe('a');
  });

  it('conjunto vazio não atribui nada', () => {
    expect(attribute([], new Map())).toBeNull();
  });
});
