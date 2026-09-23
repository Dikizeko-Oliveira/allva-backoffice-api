import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './support/source-tree';
import { loadPrismaSchema } from './support/prisma-schema';

const EVENT_MAP = readFileSync(
  join(REPO_ROOT, 'src/shared/domain/events/domain-event-map.ts'),
  'utf8',
);

const schema = loadPrismaSchema();

/** Os valores de um `enum X { … }` do `schema.prisma`. */
function prismaEnumValues(name: string): string[] {
  const match = new RegExp(`enum ${name} \\{([^}]*)\\}`, 's').exec(schema.raw);
  if (!match) return [];

  return match[1]
    .split('\n')
    .map((line) =>
      line
        .replace(/\/\/.*$/, '')
        .replace(/\/\/\/.*$/, '')
        .trim(),
    )
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

/** Os literais de uma união `export type X = 'A' | 'B'` do event map. */
function unionValues(name: string): string[] {
  const start = EVENT_MAP.indexOf(`export type ${name} =`);
  if (start === -1) return [];

  const end = EVENT_MAP.indexOf(';', start);
  return [...EVENT_MAP.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map(
    (match) => match[1],
  );
}

/**
 * **O payload de evento e a coluna precisam falar a mesma língua.**
 *
 * Estes três tipos nasceram como literais provisórios antes de A2-S1, com a nota
 * de que passariam a derivar dos enums quando o schema existisse. O schema
 * chegou com outros nomes — `USER_DIRECT` no lugar de `MANUAL`, `SUCCEEDED` no
 * lugar de `APPLIED` — e a divergência sobreviveu **um sprint inteiro**, porque
 * nenhum código emitia `action.executed`: sem emissor, `tsc` não tinha o que
 * comparar, e o teste de vocabulário de eventos verifica nomes, não payloads.
 *
 * Apareceu no primeiro emissor real, em A2-S7. Este gate é para que o próximo
 * apareça em CI e não em produção — onde o sintoma seria um consumidor
 * ignorando em silêncio um status que não reconhece.
 *
 * Derivar os tipos do `@prisma/client` resolveria por construção e é proibido:
 * `shared/domain` não importa ORM (§16.6). A paridade é verificada, então.
 */
describe('paridade entre payload de evento e enum do schema', () => {
  it.each([
    ['AdActionOrigin', 'AdActionOrigin'],
    ['ActionExecutionStatus', 'ExecutionStatus'],
    ['VerificationResult', 'VerificationResult'],
    // A2-S9: os dois que o primeiro emissor de `recommendation.outcome.measured`
    // encontrou divergentes. `OutcomeVerdict` trazia o vocabulário de
    // verificação de escrita (`CONFIRMED`/`CONTRADICTED`) e `ObservedDeltaKind`
    // trazia `ImpactType` — o tipo do impacto estimado, não o da grandeza medida.
    ['OutcomeVerdict', 'OutcomeVerdict'],
    ['ObservedDeltaKind', 'OutcomeDeltaKind'],
  ])('%s casa com o enum %s do schema', (unionName, enumName) => {
    const declared = unionValues(unionName).sort();
    const persisted = prismaEnumValues(enumName).sort();

    expect(persisted.length).toBeGreaterThan(0);
    expect(declared).toEqual(persisted);
  });

  it('encontra as uniões e os enums (guarda a guarda)', () => {
    // Um rename silencioso faria os três casos acima compararem `[]` com `[]`.
    expect(unionValues('AdActionOrigin').length).toBeGreaterThan(0);
    expect(prismaEnumValues('ExecutionStatus').length).toBeGreaterThan(0);
  });
});
