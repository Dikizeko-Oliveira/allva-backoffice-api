import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { moneyView } from './money-view';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';
import {
  IntelligenceRoute,
  ResponseEnvelope,
} from './response-envelope.decorator';
import { envelope } from './response-meta';

class LegacyController {
  list() {
    return { items: [] };
  }
}

class ContextController {
  @ResponseEnvelope()
  list() {
    return { items: [] };
  }
}

class AdsController {
  @IntelligenceRoute()
  list() {
    return { items: [] };
  }
}

function contextFor(controller: object, method: string): ExecutionContext {
  const prototype = Object.getPrototypeOf(controller) as Record<
    string,
    () => unknown
  >;

  return {
    getHandler: () => prototype[method],
    getClass: () => controller.constructor,
  } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe('ResponseEnvelopeInterceptor', () => {
  const interceptor = new ResponseEnvelopeInterceptor(new Reflector());

  const run = (context: ExecutionContext, value: unknown) =>
    firstValueFrom(interceptor.intercept(context, handlerReturning(value)));

  it('não toca em rota que não pediu envelope', async () => {
    const result = await run(contextFor(new LegacyController(), 'list'), {
      items: [1, 2],
    });

    expect(result).toEqual({ items: [1, 2] });
  });

  it('envelopa valor cru de rota marcada', async () => {
    const result = await run(contextFor(new ContextController(), 'list'), {
      items: [1],
    });

    expect(result).toEqual({ data: { items: [1] }, meta: {} });
  });

  it('preserva o meta declarado pelo handler', async () => {
    const meta = {
      asOf: '2026-07-30T03:12:00Z',
      dataMaturity: 'MATURE' as const,
      evidenceSufficiency: 'PARTIAL' as const,
      provenance: { windowDays: 14, algoVersion: 'deterministic-v2' },
      organization: { baseCurrency: 'BRL', recomputingCurrency: false },
      page: { nextCursor: 'abc', hasMore: true },
    };

    const result = await run(
      contextFor(new AdsController(), 'list'),
      envelope({ items: [] }, meta),
    );

    expect(result).toEqual({ data: { items: [] }, meta });
  });

  it('envelopa o resultado mesmo em rota não marcada quando o handler usa envelope()', async () => {
    const result = await run(
      contextFor(new LegacyController(), 'list'),
      envelope({ total: 3 }, { asOf: '2026-07-30T00:00:00Z' }),
    );

    expect(result).toEqual({
      data: { total: 3 },
      meta: { asOf: '2026-07-30T00:00:00Z' },
    });
  });

  it('recusa rota de inteligência sem asOf e sem provenance (P7)', async () => {
    await expect(
      run(contextFor(new AdsController(), 'list'), { items: [] }),
    ).rejects.toThrow(/AdsController.list.*meta.asOf, meta.provenance.*P7/s);
  });

  it('recusa rota de inteligência com asOf mas sem procedência', async () => {
    await expect(
      run(
        contextFor(new AdsController(), 'list'),
        envelope({ items: [] }, { asOf: '2026-07-30T00:00:00Z' }),
      ),
    ).rejects.toThrow(/meta.provenance/);
  });

  it('em produção registra a violação de P7 mas não derruba a rota', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    try {
      const production = new ResponseEnvelopeInterceptor(new Reflector());
      const result = await firstValueFrom(
        production.intercept(
          contextFor(new AdsController(), 'list'),
          handlerReturning({ items: [] }),
        ),
      );

      expect(result).toEqual({ data: { items: [] }, meta: {} });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('P7'));
    } finally {
      logged.mockRestore();
      process.env.NODE_ENV = previous;
    }
  });
});

describe('moneyView', () => {
  it('carrega original e base juntos, com taxa e data (§7.0.2)', () => {
    expect(
      moneyView({
        value: 1240,
        currency: 'USD',
        valueBase: 6820,
        baseCurrency: 'BRL',
        fxRate: 5.5,
        fxAsOf: new Date('2026-07-29T00:00:00Z'),
      }),
    ).toEqual({
      value: 1240,
      currency: 'USD',
      valueBase: 6820,
      baseCurrency: 'BRL',
      fxRate: 5.5,
      fxAsOf: '2026-07-29',
    });
  });

  it('omite a taxa quando não há uma — normalização pendente é declarável (M1)', () => {
    const view = moneyView({
      value: 100,
      currency: 'BRL',
      valueBase: 100,
      baseCurrency: 'BRL',
      fxRate: null,
      fxAsOf: null,
    });

    expect(view).not.toHaveProperty('fxRate');
    expect(view).not.toHaveProperty('fxAsOf');
  });
});
