import { SRC_ROOT, readSourceFiles } from './support/source-tree';

/**
 * P7 — **nenhum número sem procedência.**
 *
 * A cobrança acontece em dois lugares e os dois são necessários:
 *
 * 1. **Em runtime**, no `ResponseEnvelopeInterceptor`: uma rota marcada como de
 *    inteligência que responda sem `meta.asOf` e sem `meta.provenance` falha
 *    fora de produção. Coberto por
 *    `src/shared/infrastructure/http/envelope/response-envelope.interceptor.spec.ts`.
 * 2. **Estaticamente**, aqui: a checagem de runtime só vale para quem se
 *    declarou. Um controller de inteligência que simplesmente esqueça o
 *    decorator escaparia dela inteira — e o esquecimento é o modo de falha
 *    provável, não a má-fé.
 *
 * Os controllers listados em `LEGACY_UNENVELOPED` são anteriores à v2.0 e
 * respondem no formato antigo. Cada um sai da lista quando seu módulo for
 * reescrito — `waste` e `analytics` saíram em A2-S5, `recommendations` em A2-S6.
 * Sobrou `creative-lab`, que A2-S9 reescreve junto com os reports ad-first. A
 * lista só encolhe: um controller **novo** em qualquer módulo de inteligência já
 * nasce obrigado ao envelope.
 */

/** Módulos que produzem número derivado — onde P7 vale. */
const INTELLIGENCE_MODULES = [
  'ads',
  'ad-scoring',
  'analytics',
  'creative-lab',
  'platform-actions',
  'recommendations',
  'sync',
  'waste',
];

const LEGACY_UNENVELOPED = [
  'src/modules/creative-lab/infrastructure/http/controllers/creative-lab.controller.ts',
];

const ENVELOPE_DECORATORS = /@(IntelligenceRoute|ResponseEnvelope)\s*\(/;

const controllers = readSourceFiles(
  SRC_ROOT,
  (file) =>
    file.path.endsWith('.controller.ts') && !file.path.endsWith('.spec.ts'),
);

const intelligenceControllers = controllers.filter((file) =>
  INTELLIGENCE_MODULES.some((module) =>
    file.path.startsWith(`src/modules/${module}/`),
  ),
);

describe('P7 — procedência na superfície de inteligência', () => {
  it('todo controller de inteligência declara o envelope §7.0', () => {
    const missing = intelligenceControllers
      .filter((file) => !ENVELOPE_DECORATORS.test(file.content))
      .map((file) => file.path)
      .sort();

    expect(missing).toEqual([...LEGACY_UNENVELOPED].sort());
  });

  it('a lista legada não guarda controller que já não existe', () => {
    const existing = new Set(controllers.map((file) => file.path));
    const stale = LEGACY_UNENVELOPED.filter((path) => !existing.has(path));

    // Um item órfão aqui é permissão permanente disfarçada de dívida: some o
    // arquivo, some a cobrança, e o módulo reescrito volta sem envelope.
    expect(stale).toEqual([]);
  });

  it('nenhum controller monta { data, meta } na mão', () => {
    // O envelope é do interceptor. Montado à mão, cada rota inventa o próprio
    // `meta` e a procedência deixa de ser comparável entre telas.
    const offenders = controllers
      .filter((file) =>
        /return\s*\{\s*data:[\s\S]{0,400}?meta:/.test(file.content),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
