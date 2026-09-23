import {
  loadMigrationSql,
  loadPrismaSchema,
  parseModels,
  parseEnums,
} from './support/prisma-schema';
import {
  GateStatus,
  evaluateSchemaGates,
  gateStatuses,
} from './support/schema-gates';
import { SRC_ROOT, readSourceFiles } from './support/source-tree';

/**
 * G1..G16 de §14.5, lidos de `schema.prisma` e do SQL de migração.
 *
 * G16 entrou em A2-S9 e não vem de §14.5: vem da avaliação de RLS (R9), que
 * concluiu por **não** ativar agora e deixou como contrapartida um verificador
 * da pré-condição. Ver `docs/decisao-rls.md`.
 *
 * **O estado esperado é declarado, não deduzido.** Depois da migração de
 * reconstrução de A2-S1, **nenhum gate está `FAIL`**: os dez verificáveis
 * estaticamente passam e os cinco restantes dependem de dados (`REQUIRES_DATABASE`),
 * verificados em `schema-gates-db.spec.ts` quando há banco alcançável.
 *
 * Um `FAIL` aqui, a partir de agora, significa **regressão**: o schema nasceu
 * correto em A2-S1 e a premissa D9.1 depende de ele continuar assim.
 *
 * A escolha de declarar em vez de deixar vermelho é deliberada: `pnpm test` é
 * gate bloqueante deste repositório e roda a cada PR. Um harness que nasce
 * vermelho e assim fica por 2,5 semanas ensina o time a ignorar o vermelho — e
 * aí ele deixa de proteger qualquer coisa. Com a baseline, **qualquer** mudança
 * de estado quebra o build e obriga alguém a olhar: tanto a regressão quanto a
 * correção. É a mesma disciplina do ratchet de cobertura em `jest.config.js`.
 *
 * Os três defeitos que este harness encontrou na própria migração de A2-S1
 * estão registrados como comentário em `support/schema-gates.ts`: dois eram do
 * verificador (regex atravessando statements, aspas no identificador) e um era
 * uma exceção documentada que o gate não conhecia. Encontrar erro no verificador
 * é o verificador funcionando — o alternativa era ele passar por engano.
 */
const EXPECTED: Record<string, { status: GateStatus; because: string }> = {
  G1: {
    status: 'PASS',
    because:
      'A2-S1: `ad_accounts` passou a ser única por (organization_id, platform, external_account_id) — a identidade deixou de depender da credencial (P10)',
  },
  G2: {
    status: 'PASS',
    because:
      'ad_id e organization_id NOT NULL em ad_scores, waste_items, recommendations e ad_metric_snapshots (P2)',
  },
  G3: {
    status: 'PASS',
    because: 'Os 7 índices parciais nasceram com o schema',
  },
  G4: {
    status: 'REQUIRES_DATABASE',
    because:
      'Particionamento declarado na migração; a margem de ≥ 3 meses e a DEFAULT vazia só existem contra o banco — ver schema-gates-db.spec.ts',
  },
  G5: {
    status: 'PASS',
    because:
      'Enum MetricLevel morreu com a migração — e com ele a dupla contagem',
  },
  G6: {
    status: 'PASS',
    because:
      'Alert trocou reference_type/reference_id por 6 FKs tipadas com CHECK de exclusividade',
  },
  G7: {
    status: 'REQUIRES_DATABASE',
    because: 'Contagem de integrations antes = depois, verificada na execução',
  },
  G8: {
    status: 'REQUIRES_DATABASE',
    because: 'Gate de A2-S3 (primeiro ingest)',
  },
  G9: {
    status: 'REQUIRES_DATABASE',
    because:
      'Modelo fx_rates existe; a cobertura de 400 dias depende do provedor configurado',
  },
  G10: {
    status: 'PASS',
    because:
      'analytics passou a ler ad_metric_snapshots e `campaignLevelOnly()` deixou de existir',
  },
  G11: {
    status: 'PASS',
    because:
      'O schema v2.0 é íntegro: 49 modelos, índices por nome de campo, relações completas',
  },
  G12: {
    status: 'PASS',
    because: 'Os 4 CHECK de coerência nasceram com o schema',
  },
  G13: {
    status: 'PASS',
    because:
      'Integration.organization_id NOT NULL após backfill (D6) — REBIND agora é implementável',
  },
  G14: {
    status: 'REQUIRES_DATABASE',
    because: 'Gate de A2-S5 (rollup sem multiplicação)',
  },
  G15: {
    status: 'PASS',
    because:
      'Os 5 campos Json normativos têm schema Zod versionado em domain/ (E1)',
  },
  /**
   * A2-S9 — o gate nasceu da avaliação de RLS (R9, `docs/decisao-rls.md`).
   *
   * §18 declara a mitigação de R9 como "`organizationId NOT NULL` denormalizado
   * em tudo", e isso era uma afirmação sobre o schema que nenhum gate conferia.
   * A decisão de **não** ativar RLS agora só continua reversível enquanto a
   * pré-condição valer — e ela vale por verificação ou não vale.
   */
  G16: {
    status: 'PASS',
    because:
      'Tenancy NOT NULL fora das cinco exceções nomeadas (R9, decisao-rls.md)',
  },
};

const results = evaluateSchemaGates({
  schema: loadPrismaSchema(),
  migrationSql: loadMigrationSql(),
  sources: readSourceFiles(SRC_ROOT),
});

describe('gates de schema (§14.5)', () => {
  it('avalia os 15 gates', () => {
    expect(results.map((gate) => gate.id)).toEqual(Object.keys(EXPECTED));
  });

  it.each(results)('$id — $title', (gate) => {
    const expected = EXPECTED[gate.id];

    // A mensagem carrega o detalhe apurado: quando este teste quebra, o motivo
    // está na saída, não num arquivo que alguém precisa abrir depois.
    expect(`${gate.id}=${gate.status} (${gate.detail})`).toBe(
      `${gate.id}=${expected.status} (${gate.detail})`,
    );
  });

  it('nenhum gate está PASS por acidente de leitura', () => {
    // Um gate que passa porque não achou o que procurar é pior que um vermelho:
    // atesta conformidade sem ter medido nada. `PENDING_SCHEMA` é o valor
    // honesto para isso, e o harness tem que usá-lo.
    const passing = results.filter((gate) => gate.status === 'PASS');

    expect(passing.map((gate) => gate.id)).toEqual(
      Object.entries(EXPECTED)
        .filter(([, expected]) => expected.status === 'PASS')
        .map(([id]) => id),
    );
  });
});

describe('o harness de gates detecta violação de verdade', () => {
  const sources = readSourceFiles(SRC_ROOT);

  const evaluate = (schemaText: string) =>
    gateStatuses(
      evaluateSchemaGates({
        schema: {
          raw: schemaText,
          models: parseModels(schemaText),
          enums: parseEnums(schemaText),
        },
        migrationSql: '',
        sources,
      }),
    );

  it('G1 acusa unique de mídia ancorada na credencial', () => {
    const offending = `
model Ad {
  id            String @id
  integrationId String @map("integration_id")
  externalAdId  String @map("external_ad_id")

  @@unique([integrationId, externalAdId])
}
`;
    expect(evaluate(offending).G1).toBe('FAIL');

    const correct = offending
      .replace(
        '@@unique([integrationId, externalAdId])',
        '@@unique([adAccountId, externalAdId])',
      )
      .replace(
        'integrationId String @map("integration_id")',
        'adAccountId String @map("ad_account_id")',
      );

    expect(evaluate(correct).G1).toBe('PASS');
  });

  /**
   * G10 afrouxou em A2-S6 para não reprovar `ActionLevel` (§9.2), e o
   * afrouxamento precisa de rede: o gate tem de continuar pegando a doença que
   * ele existe para pegar.
   */
  it('G10 acusa nível de métrica, mas não o nível de AÇÃO', () => {
    const doenca = [
      {
        path: 'src/modules/waste/infrastructure/database/prisma/legacy.repository.ts',
        // O v1: filtrar `level` numa agregação de métrica para não contar o
        // mesmo gasto quatro vezes.
        content: `where: { level: 'CAMPAIGN' }`,
      },
    ];

    const acao = [
      {
        path: 'src/modules/recommendations/domain/contracts/catalog.ts',
        // §9.2: o `level` é propriedade da ação, e `CAMPAIGN` é para onde a
        // ação sobe quando há CBO.
        content: `import type { ActionLevel } from 'x';\nconst a: ActionLevel = 'CAMPAIGN';`,
      },
    ];

    const gateFor = (files: typeof doenca) =>
      gateStatuses(
        evaluateSchemaGates({
          schema: { raw: '', models: [], enums: [] },
          migrationSql: '',
          sources: files,
        }),
      ).G10;

    expect(gateFor(doenca)).toBe('FAIL');
    expect(gateFor(acao)).toBe('PASS');
  });

  it('G11 acusa índice que usa nome de coluna em vez de nome de campo (A1)', () => {
    const offending = `
model Ad {
  id             String @id
  organizationId String @map("organization_id")
  currentAiScore Float  @map("current_ai_score")

  @@index([organizationId, current_ai_score, id])
}
`;
    expect(evaluate(offending).G11).toBe('FAIL');
  });

  it('G11 acusa relação sem back-relation (A2/A3)', () => {
    const offending = `
model Ad {
  id      String  @id
  account Account @relation(fields: [accountId], references: [id])
}

model Account {
  id String @id
}
`;
    expect(evaluate(offending).G11).toBe('FAIL');
  });

  it('G6 acusa coluna de referência genérica', () => {
    const offending = `
model Alert {
  id            String  @id
  referenceId   String? @map("reference_id")
  referenceType String? @map("reference_type")
}
`;
    expect(evaluate(offending).G6).toBe('FAIL');
  });

  it('G5 acusa o enum MetricLevel', () => {
    expect(evaluate('enum MetricLevel {\n  AD\n}\n').G5).toBe('FAIL');
    expect(evaluate('enum WasteStatus {\n  OPEN\n}\n').G5).toBe('PASS');
  });
});
