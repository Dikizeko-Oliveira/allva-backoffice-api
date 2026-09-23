import {
  SRC_ROOT,
  importedModules,
  readSourceFiles,
  significantLineCount,
} from './support/source-tree';

/**
 * §16.6 — Arquitetura.
 *
 * *"Nenhum `import` de `infrastructure` dentro de `domain/` · ports são
 * `abstract class` · nenhum use case passa de ~150 linhas."*
 *
 * Estas três regras são o que mantém as camadas separadas depois que a pressa
 * chega. Sem verificador automatizado, princípio normativo degrada em ~3
 * sprints (achado D8) — e a degradação é invisível justamente porque cada
 * violação isolada parece razoável.
 */

const sources = readSourceFiles(SRC_ROOT);

const MAX_USE_CASE_LINES = 150;

/**
 * Os use cases que já nasceram grandes. A lista é **teto**, não permissão:
 * nenhum arquivo novo entra, e um que encolher abaixo do limite tem que sair
 * daqui (o teste cobra). Todos são de módulos anteriores à v2.0.
 */
const OVERSIZED_USE_CASES_BASELINE = [
  'src/modules/subscriptions/application/use-cases/create-subscription.usecase.ts',
  'src/modules/subscriptions/application/use-cases/handle-stripe-webhook.usecase.ts',
];

describe('camadas', () => {
  it('nenhum arquivo em domain/ importa infrastructure', () => {
    const offenders = sources
      .filter((file) => file.path.includes('/domain/'))
      .flatMap((file) =>
        importedModules(file.content)
          .filter((specifier) => /(^|\/)infrastructure\//.test(specifier))
          .map((specifier) => `${file.path} → ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it('nenhum arquivo em domain/ importa framework de aplicação ou ORM', () => {
    // O domínio não sabe que existe Nest, Prisma ou HTTP. Quando sabe, o teste
    // do domínio passa a precisar de container — e deixa de ser escrito.
    const forbidden = [
      '@nestjs/common',
      '@nestjs/core',
      '@prisma/client',
      'express',
    ];

    const offenders = sources
      .filter((file) => file.path.includes('/domain/'))
      .flatMap((file) =>
        importedModules(file.content)
          .filter((specifier) => forbidden.includes(specifier))
          .map((specifier) => `${file.path} → ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it('todo port é declarado como abstract class', () => {
    const ports = sources.filter(
      (file) =>
        file.path.includes('/domain/ports/') &&
        !file.path.endsWith('/index.ts') &&
        !file.path.endsWith('.spec.ts'),
    );

    expect(ports.length).toBeGreaterThan(0);

    const withoutAbstractClass = ports
      .filter((file) => !/\babstract class\b/.test(file.content))
      .map((file) => file.path);

    expect(withoutAbstractClass).toEqual([]);
  });

  it('nenhum use case novo passa de ~150 linhas', () => {
    const useCases = sources.filter(
      (file) =>
        /\.use-?case\.ts$/.test(file.path) && !file.path.endsWith('.spec.ts'),
    );

    const oversized = useCases
      .filter((file) => significantLineCount(file.content) > MAX_USE_CASE_LINES)
      .map((file) => file.path)
      .sort();

    expect(oversized).toEqual(
      OVERSIZED_USE_CASES_BASELINE.filter((path) =>
        useCases.some((file) => file.path === path),
      ),
    );
  });

  it('a baseline de use cases grandes não guarda arquivo inexistente', () => {
    const existing = new Set(sources.map((file) => file.path));
    const stale = OVERSIZED_USE_CASES_BASELINE.filter(
      (path) => !existing.has(path),
    );

    // Uma baseline que sobrevive ao arquivo que a justificava vira permissão
    // permanente — e a próxima violação entra por ela sem ninguém notar.
    expect(stale).toEqual([]);
  });
});
