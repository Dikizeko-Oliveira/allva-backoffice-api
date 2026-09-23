import { ExecuteActionUseCase } from './execute-action.usecase';
import { ExecuteBatchUseCase } from './execute-batch.usecase';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

function batchWith(execute: jest.Mock, planType: string = 'PRO') {
  return new ExecuteBatchUseCase(
    { execute } as unknown as ExecuteActionUseCase,
    new PlanEntitlementService(
      {
        findPlanTypeByOrganizationId: jest.fn().mockResolvedValue(planType),
      } as never,
      // Sem teto negociado: estes casos exercem plano, não contrato.
      {
        findOverrides: jest.fn().mockResolvedValue({
          adAccounts: null,
          monitoredAds: null,
          seats: null,
        }),
      } as never,
      /**
       * Guarda liga/desliga não reserva cota — e o dublê que lança é o que
       * prova isso. Um que devolvesse número esconderia uma reserva indevida.
       */
      {
        reserve: jest.fn(() => {
          throw new Error('guarda liga/desliga não deve reservar cota');
        }),
        release: jest.fn(),
        read: jest.fn().mockResolvedValue(0),
      } as never,
    ),
  );
}

const accepted = (executionId: string) => ({ executionId, body: {} });

function items(count: number, prefix = 'ad') {
  return Array.from({ length: count }, (_, i) => ({
    adId: `${prefix}-${i}`,
    type: 'PAUSE_AD' as const,
    parameters: { adId: `${prefix}-${i}` },
  }));
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org-1',
    accountId: 'user-1',
    body: { items: items(3), validationDepth: 'PLATFORM' as const },
    idempotencyKey: 'lote-1',
    correlationId: null,
    ipAddress: null,
    userAgent: null,
    ...overrides,
  };
}

describe('§13.5 — lote com relatório por item', () => {
  /**
   * **O gate de saída de A2-S8**: um lote de 12 com 2 recusas produz relatório
   * completo, sem abortar. O usuário pediu doze pausas; se duas forem recusadas
   * porque os anúncios já estavam pausados, as outras dez precisam acontecer —
   * abortar devolveria a ele o trabalho de descobrir quais passariam.
   */
  it('12 itens com 2 recusas produzem relatório completo', async () => {
    const execute = jest
      .fn()
      .mockImplementation(({ adId }: { adId: string }) => {
        if (adId === 'ad-3' || adId === 'ad-7') {
          throw new DomainError({
            code: 'TARGET_ALREADY_IN_STATE',
            category: 'PRECONDITION_FAILED',
            message: 'O alvo já está em PAUSED.',
          });
        }
        return Promise.resolve(accepted(`exec-${adId}`));
      });

    const result = await batchWith(execute).execute(
      request({ body: { items: items(12), validationDepth: 'PLATFORM' } }),
    );

    const report = result.data as {
      total: number;
      accepted: number;
      refused: number;
      items: Array<{ adId: string; status: string; code?: string }>;
    };

    expect(report).toMatchObject({ total: 12, accepted: 10, refused: 2 });
    expect(execute).toHaveBeenCalledTimes(12);
    expect(
      report.items.filter((item) => item.status === 'REFUSED'),
    ).toMatchObject([
      { adId: 'ad-3', code: 'TARGET_ALREADY_IN_STATE' },
      { adId: 'ad-7', code: 'TARGET_ALREADY_IN_STATE' },
    ]);
  });

  it('continua o lote depois de uma recusa, não para nela', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(
        new DomainError({
          code: 'WRITE_IN_FLIGHT',
          category: 'WRITE_IN_FLIGHT',
          message: 'escrita em andamento',
        }),
      )
      .mockResolvedValue(accepted('exec-ok'));

    const result = await batchWith(execute).execute(request());

    expect((result.data as { accepted: number }).accepted).toBe(2);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  /**
   * **Não há caminho de escrita novo.** Cada item passa pelo mesmo use case da
   * escrita individual, com a mesma cadeia de P5. Um lote que chamasse o
   * repositório direto seria uma segunda porta — e a segunda porta é a que não
   * tem as guardas.
   */
  it('delega cada item ao caminho de escrita individual', async () => {
    const execute = jest.fn().mockResolvedValue(accepted('exec-1'));

    await batchWith(execute).execute(request());

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        accountId: 'user-1',
        adId: 'ad-0',
      }),
    );
  });

  /**
   * A8 aplicado ao lote sem mecanismo novo: um retry do lote inteiro reencontra
   * as mesmas chaves e devolve as mesmas execuções, em vez de disparar uma
   * segunda rodada de escritas.
   */
  it('deriva chave de idempotência por item, a partir da do lote', async () => {
    const execute = jest.fn().mockResolvedValue(accepted('exec-1'));

    await batchWith(execute).execute(request());

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'lote-1:ad-0:PAUSE_AD' }),
    );
  });

  /**
   * Sequencial, não paralelo: cem escritas simultâneas contra a mesma conta
   * esgotariam o balde de tokens de R4, e o teto por rajada de C10 seria lido
   * antes de qualquer incremento — deixando cem passarem por um limite de trinta.
   */
  it('executa em sequência, um item por vez', async () => {
    const order: string[] = [];
    const execute = jest
      .fn()
      .mockImplementation(({ adId }: { adId: string }) => {
        order.push(`inicio-${adId}`);
        return Promise.resolve().then(() => {
          order.push(`fim-${adId}`);
          return accepted(`exec-${adId}`);
        });
      });

    await batchWith(execute).execute(request());

    expect(order).toEqual([
      'inicio-ad-0',
      'fim-ad-0',
      'inicio-ad-1',
      'fim-ad-1',
      'inicio-ad-2',
      'fim-ad-2',
    ]);
  });

  describe('guardas do lote inteiro', () => {
    /**
     * Recusar item a item produziria cem linhas dizendo a mesma coisa sobre um
     * pedido que era inválido como um todo — e teria disparado escritas antes de
     * chegar ao item que revela o problema.
     */
    it('recusa o pedido inteiro sem tocar em nenhum item', async () => {
      const execute = jest.fn();

      await expect(
        batchWith(execute).execute(
          request({ body: { items: items(101), validationDepth: 'PLATFORM' } }),
        ),
      ).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' });

      expect(execute).not.toHaveBeenCalled();
    });

    it('recusa dry-run local acima de dez itens', async () => {
      const execute = jest.fn();

      await expect(
        batchWith(execute).execute(
          request({
            body: { items: items(11), validationDepth: 'LOCAL_ONLY' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'PLATFORM_VALIDATION_REQUIRED' });

      expect(execute).not.toHaveBeenCalled();
    });

    /** R14 — conteúdo autoral nunca em lote, nem num lote de um. */
    it('recusa conteúdo autoral antes de qualquer escrita', async () => {
      const execute = jest.fn();

      await expect(
        batchWith(execute).execute(
          request({
            body: {
              items: [
                {
                  adId: 'a',
                  type: 'REPLACE_COPY',
                  parameters: { adId: 'a', primaryText: 'x', aiAuthored: true },
                },
              ],
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'AI_CONTENT_NOT_ALLOWED_IN_BATCH' });

      expect(execute).not.toHaveBeenCalled();
    });
  });

  /**
   * Um erro inesperado num item também vira linha do relatório. Deixá-lo subir
   * abortaria o lote e o usuário receberia menos informação do que se tivesse
   * clicado doze vezes.
   */
  it('transforma erro inesperado em recusa do item, não em aborto', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('conexão caiu'))
      .mockResolvedValue(accepted('exec-ok'));

    const result = await batchWith(execute).execute(request());

    const report = result.data as {
      refused: number;
      items: Array<{ code?: string }>;
    };

    expect(report.refused).toBe(1);
    expect(report.items[0].code).toBe('UNEXPECTED_ERROR');
  });
});

describe('o lote é uma capacidade do plano, não só uma soma de ações', () => {
  it('Individual não executa em lote, mesmo pedindo ações que ele pode', async () => {
    const execute = jest.fn();
    const batch = batchWith(execute, 'STARTER');

    const error = await batch.execute(request() as never).catch((e) => e);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('PLAN_FEATURE_NOT_INCLUDED');
    // Recusado como pedido: nenhum item chega ao caminho individual, senão o
    // usuário receberia doze recusas idênticas sobre algo inválido como um todo.
    expect(execute).not.toHaveBeenCalled();
  });

  it('a recusa aponta o plano que libera o lote', async () => {
    const batch = batchWith(jest.fn(), 'STARTER');

    const error = (await batch
      .execute(request() as never)
      .catch((e) => e)) as DomainError & { remediation?: string };

    expect(error.remediation).toContain('Profissional');
  });

  it('Profissional executa o lote normalmente', async () => {
    const execute = jest.fn().mockResolvedValue(accepted('exec-1'));
    const batch = batchWith(execute, 'PRO');

    await batch.execute(request() as never);

    expect(execute).toHaveBeenCalledTimes(3);
  });
});
