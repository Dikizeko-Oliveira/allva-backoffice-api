import { SyncAlertListener } from './sync-alert.listener';
import type { RaiseAlertJobData } from '../queues/alerts.dispatcher';
import type { DomainEvent } from 'src/shared/domain/events/domain-event';
import type { DomainEventName } from 'src/shared/domain/events/domain-event-map';

/**
 * `alerts` como consumidor de evento puro (§5.3 r.7) — a correção do alerta
 * órfão do v1.
 *
 * No v1 qualquer módulo injetava `CreateAlertUseCase` e montava o alerta como
 * queria; o worker de waste passava `referenceType: 'waste_item'` sem nunca
 * passar `referenceId`, e o alerta nascia apontando para lugar nenhum. O que
 * estes testes cobram é o oposto: **todo alerta sai daqui com exatamente um
 * sujeito**, e o sujeito é o certo para o tipo.
 */

function eventOf<K extends DomainEventName>(
  name: K,
  payload: DomainEvent<K>['payload'],
): DomainEvent<K> {
  return {
    eventId: 'evt-1',
    name,
    eventVersion: 1,
    occurredAt: '2026-08-01T14:00:00.000Z',
    organizationId: 'org-1',
    correlationId: 'corr-1',
    causationId: null,
    payload,
  };
}

function buildListener() {
  const raised: Array<{ data: RaiseAlertJobData; jobId?: string }> = [];
  const dispatcher = {
    raise: async (data: RaiseAlertJobData, jobId?: string) => {
      raised.push({ data, jobId });
    },
  };

  return { listener: new SyncAlertListener(dispatcher as never), raised };
}

/** Exatamente um sujeito — é o que o `CHECK` de exclusividade cobra no banco. */
function subjectKeys(subject: Record<string, unknown>): string[] {
  return Object.keys(subject).filter((key) => key !== 'kind');
}

describe('alertas de sync como consumidor de evento', () => {
  it('a guarda de arquivamento vira alerta sobre a CONTA (⊕1)', async () => {
    // Na hora em que a guarda decide não arquivar, não se sabe sequer quais
    // anúncios teriam sido arquivados — é essa a razão de `Alert` precisar de
    // seis sujeitos e não cinco.
    const h = buildListener();

    await h.listener.onArchiveSuppressed(
      eventOf('sync.archive_suppressed', {
        adAccountId: 'acc-1',
        code: 'INCOMPLETE_RESPONSE',
        reason: 'a resposta não cobriu o escopo',
      }),
    );

    expect(h.raised[0].data).toMatchObject({
      type: 'AD_ARCHIVE_SUPPRESSED',
      severity: 'WARNING',
      subject: { kind: 'AD_ACCOUNT', adAccountId: 'acc-1' },
      organizationId: 'org-1',
    });
  });

  it('a quarentena também é sobre a conta — o anúncio ainda não existe no domínio', async () => {
    const h = buildListener();

    await h.listener.onQuarantined(
      eventOf('sync.quarantined', {
        adAccountId: 'acc-1',
        externalAdId: 'ext-9',
        reason: 'CAMPAIGN_NOT_RESOLVED',
      }),
    );

    expect(h.raised[0].data.subject).toEqual({
      kind: 'AD_ACCOUNT',
      adAccountId: 'acc-1',
    });
  });

  it('drift vira alerta sobre o anúncio, com os dois estados na mensagem', async () => {
    const h = buildListener();

    await h.listener.onDrifted(
      eventOf('ad.drifted', {
        adId: 'ad-1',
        expected: 'PAUSED',
        observed: 'ACTIVE',
        driftCause: 'UNVERIFIED_WRITE',
      }),
    );

    expect(h.raised[0].data).toMatchObject({
      type: 'AD_DRIFT_DETECTED',
      subject: { kind: 'AD', adId: 'ad-1' },
    });
    expect(h.raised[0].data.message).toContain('pausado');
    expect(h.raised[0].data.message).toContain('ativo');
    // Os dois estados e a causa saem por extenso: `PAUSED`/`ACTIVE` são a
    // linguagem da plataforma, e `UNVERIFIED_WRITE` não diz a quem lê de quem é
    // o problema — se a plataforma agiu, ou se a nossa escrita não voltou.
    expect(h.raised[0].data.message).not.toContain('PAUSED');
    expect(h.raised[0].data.message).not.toContain('ACTIVE');
    expect(h.raised[0].data.message).not.toContain('UNVERIFIED_WRITE');
    expect(h.raised[0].data.message).toContain('não confirmou');
  });

  it('só UNVERIFIED_WRITE alerta; CONFIRMED e PENDING não', async () => {
    // Alertar sobre o caminho feliz e sobre degraus intermediários ensinaria o
    // usuário a ignorar a caixa de alertas antes do primeiro caso real.
    const h = buildListener();

    for (const verificationResult of [
      'CONFIRMED',
      'INCONCLUSIVE',
      'DIVERGED',
    ] as const) {
      await h.listener.onVerified(
        eventOf('action.verified', {
          adId: 'ad-1',
          executionId: 'exec-1',
          verificationResult,
        }),
      );
    }
    expect(h.raised).toHaveLength(0);

    await h.listener.onVerified(
      eventOf('action.verified', {
        adId: 'ad-1',
        executionId: 'exec-1',
        verificationResult: 'UNVERIFIED_WRITE',
      }),
    );

    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].data).toMatchObject({
      type: 'UNVERIFIED_WRITE',
      severity: 'CRITICAL',
    });
  });

  it('rebind sem conta perdida não gera alerta nenhum', async () => {
    const h = buildListener();

    await h.listener.onRebound(
      eventOf('integration.rebound', {
        previousIntegrationId: 'int-antiga',
        integrationId: 'int-nova',
        reboundAdAccountIds: ['acc-1'],
        unreachableAdAccountIds: [],
      }),
    );

    expect(h.raised).toHaveLength(0);
  });

  it('rebind com contas perdidas gera um alerta por conta', async () => {
    const h = buildListener();

    await h.listener.onRebound(
      eventOf('integration.rebound', {
        previousIntegrationId: 'int-antiga',
        integrationId: 'int-nova',
        reboundAdAccountIds: [],
        unreachableAdAccountIds: ['acc-1', 'acc-2'],
      }),
    );

    expect(h.raised).toHaveLength(2);
    expect(h.raised.map((entry) => entry.data.subject)).toEqual([
      { kind: 'AD_ACCOUNT', adAccountId: 'acc-1' },
      { kind: 'AD_ACCOUNT', adAccountId: 'acc-2' },
    ]);
    // O jobId separa as duas: sem o sufixo por conta, a segunda colidiria com a
    // primeira e o usuário perderia metade do aviso.
    expect(new Set(h.raised.map((entry) => entry.jobId)).size).toBe(2);
  });

  it('desconexão de integração aponta para a INTEGRAÇÃO', async () => {
    const h = buildListener();

    await h.listener.onDisconnected(
      eventOf('integration.disconnected', {
        integrationId: 'int-1',
        adAccountIds: ['acc-1', 'acc-2'],
      }),
    );

    expect(h.raised[0].data.subject).toEqual({
      kind: 'INTEGRATION',
      integrationId: 'int-1',
    });
  });

  it('todo alerta emitido declara exatamente um sujeito', async () => {
    const h = buildListener();

    await h.listener.onArchiveSuppressed(
      eventOf('sync.archive_suppressed', {
        adAccountId: 'acc-1',
        code: 'STEP_FAILED',
        reason: 'x',
      }),
    );
    await h.listener.onDrifted(
      eventOf('ad.drifted', {
        adId: 'ad-1',
        expected: 'PAUSED',
        observed: 'ACTIVE',
        driftCause: 'UNVERIFIED_WRITE',
      }),
    );
    await h.listener.onDisconnected(
      eventOf('integration.disconnected', {
        integrationId: 'int-1',
        adAccountIds: [],
      }),
    );

    for (const entry of h.raised) {
      expect(subjectKeys(entry.data.subject)).toHaveLength(1);
    }
  });

  it('a correlação do evento atravessa a fila (§5.6.2)', async () => {
    // Sem isso, o alerta que aparece na tela às 14h07 deixa de ser rastreável
    // até o ingest das 14h que o causou.
    const h = buildListener();

    await h.listener.onQuarantined(
      eventOf('sync.quarantined', {
        adAccountId: 'acc-1',
        externalAdId: 'ext-1',
        reason: 'x',
      }),
    );

    expect(h.raised[0].data.ctx).toEqual({
      correlationId: 'corr-1',
      causationId: 'evt-1',
    });
  });
});
