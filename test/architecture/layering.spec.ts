import {
  SRC_ROOT,
  importedModules,
  readSourceFiles,
  significantLineCount,
} from './support/source-tree';

/**
 * As regras de camada do `allva-api`, cobradas aqui também.
 *
 * *"Nenhum `import` de `infrastructure` dentro de `domain/` · ports são
 * `abstract class` · nenhum use case passa de ~150 linhas."* Sem verificador
 * automatizado, princípio normativo degrada — e a degradação é invisível,
 * porque cada violação isolada parece razoável.
 */

const sources = readSourceFiles(SRC_ROOT);

const MAX_USE_CASE_LINES = 150;

/**
 * Módulos sem camadas, por decisão — como `health` no `allva-api`: um
 * controller sem regra de negócio, que só pergunta ao banco se ele responde.
 */
const FLAT_MODULES = new Set(['health']);

function isFlatModule(path: string): boolean {
  const name = /^src\/modules\/([^/]+)\//.exec(path)?.[1];
  return name !== undefined && FLAT_MODULES.has(name);
}

describe('camadas', () => {
  it('nenhum arquivo em domain/ importa infrastructure ou application', () => {
    const offenders = sources
      .filter((file) => file.path.includes('/domain/'))
      .flatMap((file) =>
        importedModules(file.content)
          .filter((specifier) =>
            /(^|\/)(infrastructure|application)\//.test(specifier),
          )
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
          .filter(
            (specifier) =>
              forbidden.includes(specifier) ||
              specifier.startsWith('generated/'),
          )
          .map((specifier) => `${file.path} → ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it('nenhum arquivo em application/ importa infrastructure de módulo', () => {
    // A aplicação fala com ports. Um use case que importa o repositório Prisma
    // ou o gateway HTTP direto amarra a regra ao transporte. `shared/` fica de
    // fora: paginação e config são transversais.
    const offenders = sources
      .filter((file) => file.path.includes('/application/'))
      .flatMap((file) =>
        importedModules(file.content)
          .filter((specifier) =>
            /modules\/[^/]+\/infrastructure\/|^\.\.?\/.*infrastructure\//.test(
              specifier,
            ),
          )
          .map((specifier) => `${file.path} → ${specifier}`),
      );

    expect(offenders).toEqual([]);
  });

  it('só a infraestrutura toca o Prisma', () => {
    const offenders = sources
      .filter(
        (file) =>
          !file.path.includes('/infrastructure/') &&
          !isFlatModule(file.path) &&
          /\bPrismaService\b|from 'generated\//.test(file.content),
      )
      .map((file) => file.path);

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

  it('nenhum use case passa de ~150 linhas', () => {
    const oversized = sources
      .filter(
        (file) =>
          /\.usecase\.ts$/.test(file.path) &&
          significantLineCount(file.content) > MAX_USE_CASE_LINES,
      )
      .map((file) => file.path);

    expect(oversized).toEqual([]);
  });

  it('todo módulo segue o layout domain / application / infrastructure', () => {
    const modules = new Set(
      sources
        .map((file) => /^src\/modules\/([^/]+)\//.exec(file.path)?.[1])
        .filter((name): name is string => Boolean(name)),
    );

    const missing = [...modules]
      .filter((name) => !FLAT_MODULES.has(name))
      .flatMap((name) =>
        ['domain', 'application', 'infrastructure']
          .filter(
            (layer) =>
              !sources.some((file) =>
                file.path.startsWith(`src/modules/${name}/${layer}/`),
              ),
          )
          .map((layer) => `${name}/${layer}`),
      );

    expect(missing).toEqual([]);
  });
});
