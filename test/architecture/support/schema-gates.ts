import { PrismaModel, PrismaSchema, scalarField } from './prisma-schema';

/**
 * Os 15 gates de §14.5, avaliados contra `schema.prisma` + o SQL de migração.
 *
 * Quatro estados, e a distinção entre eles é o ponto:
 *
 * | Estado | Significado |
 * |---|---|
 * | `PASS` | a invariante vale hoje |
 * | `FAIL` | o objeto existe e **viola** a invariante |
 * | `PENDING_SCHEMA` | o objeto que a invariante governa ainda não existe |
 * | `REQUIRES_DATABASE` | só verificável contra dados (`information_schema` ou ingest) |
 *
 * `PENDING_SCHEMA` não é "passou": é "não há o que medir ainda". A migração de
 * reconstrução de A2-S1 é que cria o objeto, e no dia em que criar, o gate vira
 * `PASS` ou `FAIL` sozinho — e a baseline do spec obriga alguém a olhar.
 */

export type GateStatus =
  | 'PASS'
  | 'FAIL'
  | 'PENDING_SCHEMA'
  | 'REQUIRES_DATABASE';

export type GateResult = {
  id: string;
  title: string;
  status: GateStatus;
  detail: string;
};

export type GateInput = {
  schema: PrismaSchema;
  migrationSql: string;
  /** Conteúdo dos arquivos de `src/`, por caminho relativo — para G10 e G15. */
  sources: { path: string; content: string }[];
};

/**
 * Entidades de mídia — as que descrevem o que existe na plataforma. É sobre
 * elas que P10 vale: a identidade do domínio não pode depender da credencial.
 * A lista cobre v1 e v2 porque o harness roda durante a transição.
 */
const MEDIA_MODELS = [
  'AdAccount',
  'Campaign',
  'AdSet',
  'Ad',
  'Creative',
  'CreativeAsset',
  'ExternalCampaign',
  'ExternalAdSet',
  'ExternalAd',
  'ExternalCreative',
  'MetricSnapshot',
  'AdMetricSnapshot',
];

/**
 * Tabelas de inteligência — as que carregam diagnóstico, não fato observado.
 *
 * `CreativeAnalysis` fica **fora** da lista: §4.7 declara `ad_id` nullable nela,
 * e só nela, para as análises de upload pré-veiculação (D7.1). Incluí-la faria o
 * gate acusar como violação uma exceção que o documento concede — e um gate que
 * reprova o schema correto é abandonado na segunda vez que reprova.
 */
const INTELLIGENCE_MODELS = [
  'AdScore',
  'WasteItem',
  'Recommendation',
  'AdMetricSnapshot',
];

/** Campos genéricos de referência: o mecanismo que produziu o alerta órfão. */
const FORBIDDEN_GENERIC_REFERENCES = [
  'subjectType',
  'subjectId',
  'referenceType',
  'referenceId',
];

const NORMATIVE_JSON_FIELDS: { model: string; field: string }[] = [
  { model: 'AdScore', field: 'components' },
  { model: 'DetectorProfile', field: 'thresholds' },
  { model: 'AdAction', field: 'parameters' },
  { model: 'WasteItem', field: 'evidence' },
  { model: 'Recommendation', field: 'impacts' },
  /**
   * As quatro colunas de sugestão de §11.4, que nasceram em A2-S1 sem produtor
   * e passaram a ser escritas com a geração de copy. Entram aqui **junto** com o
   * produtor: uma coluna Json que começa a receber conteúdo sem schema é
   * exatamente o `result: Json` sem esquema nem versão que §6.3 registra como
   * defeito do v1.
   */
  { model: 'CreativeAnalysis', field: 'hookSuggestions' },
  { model: 'CreativeAnalysis', field: 'bodySuggestions' },
  { model: 'CreativeAnalysis', field: 'ctaSuggestions' },
  { model: 'CreativeAnalysis', field: 'formatSuggestions' },
  /** O snapshot do que entrou no prompt da geração (P7). */
  { model: 'CopyGeneration', field: 'context' },
  /** "Por que a Allva recomenda esta versão", ligado às sugestões de origem. */
  { model: 'CopyVariant', field: 'reasoning' },
];

export function evaluateSchemaGates(input: GateInput): GateResult[] {
  return [
    gate1(input),
    gate2(input),
    gate3(input),
    gate4(input),
    gate5(input),
    gate6(input),
    gate7(),
    gate8(),
    gate9(input),
    gate10(input),
    gate11(input),
    gate12(input),
    gate13(input),
    gate14(),
    gate15(input),
    gate16(input),
  ];
}

export function gateStatuses(
  results: GateResult[],
): Record<string, GateStatus> {
  return Object.fromEntries(results.map((gate) => [gate.id, gate.status]));
}

function modelsPresent(schema: PrismaSchema, names: string[]): PrismaModel[] {
  return schema.models.filter((model) => names.includes(model.name));
}

// G1 — nenhuma unique de mídia referencia `integration_id` (P10).
function gate1({ schema }: GateInput): GateResult {
  const media = modelsPresent(schema, MEDIA_MODELS);
  const offenders = media.flatMap((model) =>
    model.uniques
      .filter((keys) => keys.includes('integrationId'))
      .map((keys) => `${model.name}: @@unique([${keys.join(', ')}])`),
  );

  return {
    id: 'G1',
    title:
      'Nenhuma unique de entidade de mídia referencia integration_id (P10)',
    status:
      media.length === 0
        ? 'PENDING_SCHEMA'
        : offenders.length
          ? 'FAIL'
          : 'PASS',
    detail: offenders.length
      ? `Identidade ancorada na credencial: ${offenders.join(' · ')}`
      : `${media.length} modelos de mídia verificados`,
  };
}

// G2 — toda tabela de inteligência tem `ad_id` e `organization_id` NOT NULL.
function gate2({ schema }: GateInput): GateResult {
  const intelligence = modelsPresent(schema, INTELLIGENCE_MODELS);
  if (intelligence.length === 0) {
    return pending(
      'G2',
      'Toda tabela de inteligência tem ad_id e organization_id NOT NULL',
    );
  }

  const offenders = intelligence.flatMap((model) =>
    ['adId', 'organizationId']
      .filter((name) => {
        const field = scalarField(model, name);
        return !field || field.optional;
      })
      .map((name) => `${model.name}.${name}`),
  );

  return {
    id: 'G2',
    title: 'Toda tabela de inteligência tem ad_id e organization_id NOT NULL',
    status: offenders.length ? 'FAIL' : 'PASS',
    detail: offenders.length
      ? `Ausente ou nullable: ${offenders.join(', ')}`
      : `${intelligence.length} tabelas verificadas`,
  };
}

// G3 — os sete índices parciais existem (são invariantes, não otimização).
function gate3({ migrationSql }: GateInput): GateResult {
  // `[^;]*?` em vez de `[\s\S]*?`: sem a fronteira de statement, um
  // `CREATE INDEX` comum casava com o `WHERE` de qualquer comando seguinte, e a
  // contagem saía inflada — o gate acusava 8 onde havia 7.
  const count = countMatches(
    migrationSql,
    /CREATE\s+(UNIQUE\s+)?INDEX[^;]*?\sWHERE\s/gi,
  );

  return {
    id: 'G3',
    title: 'Os sete índices parciais existem',
    status: count === 0 ? 'PENDING_SCHEMA' : count === 7 ? 'PASS' : 'FAIL',
    detail: `${count} índice(s) parcial(is) nas migrações; §14.4 exige 7`,
  };
}

// G4 — `ad_metric_snapshots` particionada, com partições futuras e DEFAULT.
function gate4({ migrationSql }: GateInput): GateResult {
  if (!/ad_metric_snapshots/i.test(migrationSql)) {
    return pending(
      'G4',
      'ad_metric_snapshots particionada com DEFAULT e partições futuras',
    );
  }

  // As aspas são opcionais: o SQL gerado pelo Prisma cita todo identificador.
  const partitioned = /PARTITION\s+BY\s+RANGE\s*\(\s*"?date"?\s*\)/i.test(
    migrationSql,
  );
  const hasDefault = /PARTITION\s+OF\s+"?ad_metric_snapshots"?\s+DEFAULT/i.test(
    migrationSql,
  );

  return {
    id: 'G4',
    title: 'ad_metric_snapshots particionada com DEFAULT e partições futuras',
    status: partitioned && hasDefault ? 'REQUIRES_DATABASE' : 'FAIL',
    detail: partitioned
      ? 'Particionamento declarado; a margem de 3 meses só é verificável no banco'
      : 'Tabela criada sem PARTITION BY RANGE(date)',
  };
}

// G5 — o enum `MetricLevel` não existe (a dupla contagem morre com ele).
function gate5({ schema }: GateInput): GateResult {
  const present = schema.enums.includes('MetricLevel');

  return {
    id: 'G5',
    title: 'Enum MetricLevel não existe',
    status: present ? 'FAIL' : 'PASS',
    detail: present
      ? 'MetricLevel ainda declarado — é o que permite métrica em nível de campanha'
      : 'Ausente, como esperado',
  };
}

// G6 — nenhuma coluna de referência genérica (a raiz do alerta órfão).
function gate6({ schema }: GateInput): GateResult {
  const offenders = schema.models.flatMap((model) =>
    model.fields
      .filter((field) => FORBIDDEN_GENERIC_REFERENCES.includes(field.name))
      .map((field) => `${model.name}.${field.name}`),
  );

  return {
    id: 'G6',
    title: 'Nenhuma coluna subject_type/subject_id/reference_type/reference_id',
    status: offenders.length ? 'FAIL' : 'PASS',
    detail: offenders.length
      ? `Referência genérica sem FK: ${offenders.join(', ')}`
      : 'Nenhuma referência genérica',
  };
}

// G7 — `integrations` preservada; nenhum usuário reconecta.
function gate7(): GateResult {
  return {
    id: 'G7',
    title: 'integrations preservada na migração (contagem antes = depois)',
    status: 'REQUIRES_DATABASE',
    detail: 'Verificado na execução da migração de A2-S1, contra o banco',
  };
}

// G8 — primeiro ingest popula `ads` com FKs resolvidas e `lineage_id`.
function gate8(): GateResult {
  return {
    id: 'G8',
    title: 'Primeiro ingest popula ads com FKs resolvidas e lineage_id',
    status: 'REQUIRES_DATABASE',
    detail: 'Gate de A2-S3, contra dados reais de ingest',
  };
}

// G9 — `fx_rates` populada com backfill histórico contra o pivô.
function gate9({ schema }: GateInput): GateResult {
  const exists = schema.models.some((model) => model.tableName === 'fx_rates');

  return {
    id: 'G9',
    title: 'fx_rates com backfill histórico contra o pivô (≥ 400 dias)',
    status: exists ? 'REQUIRES_DATABASE' : 'PENDING_SCHEMA',
    detail: exists
      ? 'Modelo existe; a cobertura de datas só é verificável no banco'
      : 'Modelo fx_rates nasce em A2-S1',
  };
}

/**
 * G10 — nenhum resquício de **nível de métrica** na inteligência.
 *
 * A doença do v1 é precisa: `MetricSnapshot.level` e `WasteItem.level` guardavam
 * a mesma grandeza em quatro níveis, e toda agregação tinha de lembrar de
 * filtrar um deles para não contar o mesmo gasto quatro vezes.
 *
 * **`ActionLevel` é outra coisa, e é mandatória.** §9.2 declara que o `level`
 * (`AD`/`AD_SET`/`CAMPAIGN`) é propriedade da **ação**: a recomendação é sobre o
 * anúncio, e a ação incide onde o orçamento vive. Acusar isso como resquício
 * reprovaria o schema correto — e um gate que reprova o correto é abandonado na
 * segunda vez que reprova.
 *
 * A distinção é o vocabulário: quem usa `ActionLevel` está no domínio da ação. O
 * gate continua acusando qualquer outro `level … CAMPAIGN` nos três módulos.
 */
function gate10({ sources }: GateInput): GateResult {
  const scoped = sources.filter((file) =>
    /^src\/modules\/(waste|analytics|recommendations)\//.test(file.path),
  );

  const offenders = scoped
    .filter((file) => /level.*CAMPAIGN/.test(file.content))
    .filter((file) => !/\bActionLevel\b/.test(file.content))
    .map((file) => file.path);

  return {
    id: 'G10',
    title: 'Nenhum "level ... CAMPAIGN" em waste/analytics/recommendations',
    status: offenders.length ? 'FAIL' : 'PASS',
    detail: offenders.length
      ? `Nível de campanha ainda vivo em: ${offenders.join(', ')}`
      : 'Limpo',
  };
}

// G11 — o schema compila: índices referenciam campos, relações têm back-relation.
function gate11({ schema }: GateInput): GateResult {
  const problems: string[] = [];
  const modelNames = new Set(schema.models.map((model) => model.name));

  for (const model of schema.models) {
    const fieldNames = new Set(model.fields.map((field) => field.name));

    for (const keys of [...model.indexes, ...model.uniques]) {
      for (const key of keys) {
        if (!fieldNames.has(key)) {
          problems.push(
            `${model.name}: índice referencia "${key}", que não é campo`,
          );
        }
      }
    }

    // Back-relation: todo campo que aponta para outro modelo precisa de par do
    // outro lado, senão o Prisma não gera (achados A2 e A3).
    for (const field of model.fields) {
      if (!modelNames.has(field.type) || field.type === model.name) continue;

      const target = schema.models.find((other) => other.name === field.type);
      const hasBackRelation = target?.fields.some(
        (other) => other.type === model.name,
      );

      if (!hasBackRelation) {
        problems.push(
          `${model.name}.${field.name}: ${field.type} não declara back-relation`,
        );
      }
    }
  }

  return {
    id: 'G11',
    title:
      'Schema íntegro: índices por nome de campo, relações com back-relation',
    status: problems.length ? 'FAIL' : 'PASS',
    detail: problems.length
      ? problems.join(' · ')
      : `${schema.models.length} modelos íntegros`,
  };
}

// G12 — os quatro CHECK de coerência existem.
function gate12({ migrationSql }: GateInput): GateResult {
  const count = countMatches(migrationSql, /\bCHECK\s*\(/gi);

  return {
    id: 'G12',
    title: 'Os quatro CHECK de coerência existem',
    status: count === 0 ? 'PENDING_SCHEMA' : count >= 4 ? 'PASS' : 'FAIL',
    detail: `${count} CHECK nas migrações; §14.5 exige 4 (waste_items ×2, alerts, ai_decision_logs)`,
  };
}

// G13 — `Integration.organization_id` é NOT NULL (pré-requisito do REBIND).
function gate13({ schema }: GateInput): GateResult {
  const integration = schema.models.find(
    (model) => model.name === 'Integration',
  );
  if (!integration)
    return pending('G13', 'Integration.organization_id é NOT NULL');

  const field = scalarField(integration, 'organizationId');

  return {
    id: 'G13',
    title: 'Integration.organization_id é NOT NULL',
    status: field && !field.optional ? 'PASS' : 'FAIL',
    detail: field
      ? field.optional
        ? 'Ainda nullable — sem isso REBIND (P10) não é implementável'
        : 'NOT NULL'
      : 'Campo ausente',
  };
}

// G14 — rollup de campanha não multiplica por achado.
function gate14(): GateResult {
  return {
    id: 'G14',
    title: 'Rollup não multiplica: ad com 3 achados abertos entra 1×',
    // Continua `REQUIRES_DATABASE` **por natureza**, não por pendência: a
    // multiplicação é do `JOIN`, e nenhuma leitura de `schema.prisma` a enxerga.
    // Coberto desde A2-S5 por `test/integration/waste-rollup.spec.ts`, que roda
    // a query errada ao lado da certa — 4200 contra 1400 — porque sem o
    // contraste a asserção seria um número sem oposição.
    status: 'REQUIRES_DATABASE',
    detail:
      'Verificado em test/integration/waste-rollup.spec.ts (A2-S5), contra o Postgres',
  };
}

// G15 — todo campo Json normativo tem schema Zod versionado em domain/.
function gate15({ schema, sources }: GateInput): GateResult {
  const present = NORMATIVE_JSON_FIELDS.filter(({ model, field }) => {
    const target = schema.models.find((candidate) => candidate.name === model);
    return target && scalarField(target, field)?.type === 'Json';
  });

  if (present.length === 0) {
    return pending(
      'G15',
      'Todo campo Json normativo tem schema Zod versionado em domain/',
    );
  }

  const domainSchemas = sources.filter(
    (file) =>
      file.path.includes('/domain/') &&
      /from ['"]zod['"]/.test(file.content) &&
      /schemaVersion/.test(file.content),
  );

  const covered = present.filter(({ field }) =>
    domainSchemas.some((file) => new RegExp(field, 'i').test(file.content)),
  );

  return {
    id: 'G15',
    title: 'Todo campo Json normativo tem schema Zod versionado em domain/',
    status: covered.length === present.length ? 'PASS' : 'FAIL',
    detail: `${covered.length}/${present.length} campos Json normativos cobertos por schema versionado`,
  };
}

/**
 * As quatro tabelas que legitimamente têm `organization_id` nullable.
 *
 * A lista é **fechada e nomeada** de propósito: cada uma tem uma razão viva, e
 * uma tabela nova que nasça nullable tem de quebrar o build em vez de entrar por
 * uma regra genérica. Ver `docs/decisao-rls.md`.
 */
const ORGANIZATION_NULLABLE_BY_DESIGN: Record<string, string> = {
  AuditLog: 'eventos de conta acontecem antes de existir organização',
  SecurityAuditLog: 'login falhado não tem organização: não se sabe quem é',
  Report: 'linhas do v1; A2-S9 passou a recusar geração sem organização',
  DetectorProfile:
    'perfil global é o padrão do produto, e o null é o que o torna global',
  EnterpriseContract:
    'o contrato é assinado antes de existir organização — é a ativação dele que a provisiona',
};

/**
 * G16 (A2-S9) — **a pré-condição de RLS não pode se degradar em silêncio**.
 *
 * §18 declara a mitigação de R9 como *"`organizationId NOT NULL` denormalizado
 * em tudo"*, e até A2-S9 isso era uma afirmação sobre o schema que nenhum gate
 * verificava. A decisão de não ativar RLS agora (`docs/decisao-rls.md`) só
 * continua reversível enquanto a pré-condição valer — e ela vale por verificação
 * ou não vale.
 */
function gate16({ schema }: GateInput): GateResult {
  const offenders = schema.models
    .filter((model) => !(model.name in ORGANIZATION_NULLABLE_BY_DESIGN))
    .filter((model) => scalarField(model, 'organizationId')?.optional === true)
    .map((model) => model.name);

  const exceptionsPresent = Object.keys(ORGANIZATION_NULLABLE_BY_DESIGN).filter(
    (name) => schema.models.some((model) => model.name === name),
  );

  if (exceptionsPresent.length === 0 && offenders.length === 0) {
    return pending(
      'G16',
      'organization_id NOT NULL fora das exceções nomeadas',
    );
  }

  return {
    id: 'G16',
    title: 'organization_id NOT NULL fora das exceções nomeadas (R9)',
    status: offenders.length === 0 ? 'PASS' : 'FAIL',
    detail: offenders.length
      ? `Tenancy sem NOT NULL e sem exceção declarada: ${offenders.join(' · ')}`
      : `${exceptionsPresent.length} exceções nomeadas; nenhuma tabela nova nullable`,
  };
}

function pending(id: string, title: string): GateResult {
  return {
    id,
    title,
    status: 'PENDING_SCHEMA',
    detail: 'O objeto governado por este gate nasce na migração de A2-S1',
  };
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}
