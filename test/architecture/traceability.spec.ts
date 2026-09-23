import {
  DOMAIN_EVENT_NAMES,
  DOMAIN_EVENT_VERSIONS,
} from '../../src/shared/domain/events/domain-event-map';
import {
  SRC_ROOT,
  importedModules,
  readSourceFiles,
} from './support/source-tree';

/**
 * §16.15 — Rastreabilidade.
 *
 * *"Todo evento carrega `eventId`, `eventVersion`, `correlationId` e
 * `causationId` · todo payload de job Bull carrega `JobContext` · handler de
 * evento que faz I/O pesado apenas enfileira."*
 */

/**
 * Os nomes da tabela de §5.6, transcritos. Divergência aqui é erro.
 *
 * **Dois não vêm do documento**, e os dois nasceram da mesma impossibilidade:
 * um tipo de alerta declarado no schema, `alerts` proibido de receber injeção
 * direta (§5.3 r.7) e nenhum evento que carregasse a condição.
 *
 * - `sync.archive_suppressed` (A2-S3) — `AD_ARCHIVE_SUPPRESSED`;
 * - `denormalization.drift_detected` (A2-S5) — `DENORMALIZATION_DRIFT`, que
 *   §10.8 manda emitir quando o job corrige a divergência.
 *
 * O terceiro nasceu de uma impossibilidade de outra natureza:
 *
 * - `ad_account.first_sync_completed` — `ad-scoring`, `waste` e
 *   `recommendations` importam `SyncModule` pelo lease de `JobRun`, então o
 *   `sync` não pode acordá-los sem fechar ciclo de módulo. Sem o evento, a
 *   única via era esperar os crons da madrugada, e "conectei minha conta" e
 *   "recebi um diagnóstico" ficavam separados por um dia inteiro.
 *
 * O quarto é da mesma natureza do terceiro:
 *
 * - `organization.deleted` — excluir a organização precisa revogar as
 *   credenciais das plataformas, e `integrations` importa `OrganizationsModule`;
 *   chamá-lo de dentro de `organizations` fecharia o mesmo tipo de ciclo.
 *
 * A lista **não** é livre: um nome novo aqui exige a mesma justificativa
 * registrada no `DomainEventMap`, ao lado do payload.
 */
const DOCUMENTED_EVENTS = [
  'ad.discovered',
  'ad.derived',
  'ad.metrics.updated',
  'ad.status.changed',
  'ad.archived',
  'ad.scored',
  'ad.drifted',
  'waste.detected',
  'waste.resolved',
  'denormalization.drift_detected',
  'recommendation.generated',
  'recommendation.applied',
  'recommendation.outcome.measured',
  'action.executed',
  'action.reverted',
  'action.verified',
  'calibration.published',
  'integration.disconnected',
  'integration.rebound',
  'ad_account.discovered',
  'sync.quarantined',
  'sync.archive_suppressed',
  'ad_account.first_sync_completed',
  'organization.base_currency.change_requested',
  'organization.base_currency.recomputed',
  'organization.deleted',
];

/**
 * Filas anteriores à v2.0, sem `JobContext` no payload porque nasceram antes de
 * haver cadeia para propagar.
 *
 * A lista **encolheu de sete para uma** em A2-S1: as filas de campanha, ingest,
 * waste, recomendação e otimização criativa saíram junto com as tabelas que
 * alimentavam. Sobrou `reports`, que não foi tocada. Fila nova já nasce obrigada
 * a carregar contexto — e a lista só encolhe.
 */
const LEGACY_QUEUES_WITHOUT_JOB_CONTEXT = [
  'src/modules/reports/infrastructure/queues/reports.dispatcher.ts',
];

const sources = readSourceFiles(SRC_ROOT);

const dispatchers = sources.filter(
  (file) =>
    /\/queues\/[^/]+\.dispatcher\.ts$/.test(file.path) &&
    !file.path.endsWith('.spec.ts'),
);

const eventHandlers = sources.filter(
  (file) =>
    /@OnDomainEvent\s*\(/.test(file.content) && !file.path.endsWith('.spec.ts'),
);

describe('eventos de domínio', () => {
  it('declara exatamente os eventos de §5.6 mais os derivados registrados', () => {
    expect([...DOMAIN_EVENT_NAMES].sort()).toEqual(
      [...DOCUMENTED_EVENTS].sort(),
    );
  });

  it('todo evento tem versão na envelope, nunca no nome', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      expect(DOMAIN_EVENT_VERSIONS[name]).toBeGreaterThanOrEqual(1);
      // `ad.scored.v2` fragmentaria as assinaturas: o consumidor da v1 pararia
      // de receber tudo em vez de receber e ignorar o que não conhece.
      expect(name).not.toMatch(/\.v\d+$/);
    }
  });

  it('nenhum módulo emite evento sem passar pelo DomainEventBus', () => {
    // A verificação é por **import**, não por menção textual.
    //
    // A primeira redação procurava a string `EventEmitter2` no arquivo inteiro,
    // e em A2-S3 ela passou a acusar quatro arquivos cujo único crime era
    // *explicar* que `EventEmitter2` é síncrono — justamente a razão de o
    // handler só enfileirar (⊕10). Um verificador que pune quem documenta a
    // regra ensina o time a não documentá-la. O import é o que de fato dá acesso
    // ao emissor cru, e nenhum módulo precisa dele: quem assina evento usa
    // `@OnDomainEvent`, quem emite usa `DomainEventBus`.
    const offenders = sources
      .filter(
        (file) =>
          file.path.startsWith('src/modules/') &&
          !file.path.endsWith('.spec.ts') &&
          importedModules(file.content).includes('@nestjs/event-emitter'),
      )
      .map((file) => file.path);

    // Emitir cru pelo `EventEmitter2` pula a envelope inteira — sem `eventId`
    // não há causalidade (⊕15), e a cadeia fica irreconstruível justamente nos
    // saltos que se quer auditar.
    expect(offenders).toEqual([]);
  });
});

describe('fronteira da fila', () => {
  it('todo payload de job novo carrega JobContext', () => {
    const withoutContext = dispatchers
      .filter((file) => !/\bJobContext\b/.test(file.content))
      .map((file) => file.path)
      .sort();

    expect(withoutContext).toEqual(
      LEGACY_QUEUES_WITHOUT_JOB_CONTEXT.filter((path) =>
        dispatchers.some((file) => file.path === path),
      ),
    );
  });

  it('a lista de filas legadas não guarda arquivo inexistente', () => {
    const existing = new Set(sources.map((file) => file.path));
    const stale = LEGACY_QUEUES_WITHOUT_JOB_CONTEXT.filter(
      (path) => !existing.has(path),
    );

    expect(stale).toEqual([]);
  });
});

describe('handler de evento (⊕10)', () => {
  it('não faz I/O pesado inline — apenas enfileira', () => {
    const forbidden = [/PrismaService/, /Repository\b/, /\.repository/];

    const offenders = eventHandlers
      .filter((file) =>
        importedModules(file.content).some((specifier) =>
          forbidden.some((pattern) => pattern.test(specifier)),
        ),
      )
      .map((file) => file.path);

    // `EventEmitter2` é síncrono: um handler que persiste ou chama plataforma
    // inline põe a latência da cadeia inteira dentro do emissor — o `sync`
    // passa a esperar o scoring terminar.
    expect(offenders).toEqual([]);
  });
});
