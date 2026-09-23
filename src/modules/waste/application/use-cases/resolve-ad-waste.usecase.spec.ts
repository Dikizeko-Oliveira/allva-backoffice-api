import { NotFoundException } from '@nestjs/common';
import { ResolveAdWasteUseCase } from './resolve-ad-waste.usecase';
import type { EnvService } from 'src/shared/infrastructure/config/env.service';
import type { FindingType } from 'src/modules/waste/domain/contracts/finding-catalog';

/**
 * `POST /ads/{id}/resolve` (§10.9, linha "por anúncio").
 *
 * O que estes testes fixam é a ordem e o alcance: resolve, **recalcula a
 * denormalização** e só então responde. Sem o recálculo o anúncio ficaria com o
 * `openWasteCount` antigo até o ciclo da madrugada — um dia inteiro exibindo
 * dinheiro queimando num anúncio que o usuário acabou de limpar.
 */

const OPEN: Array<{ id: string; type: FindingType }> = [
  { id: 'item-1', type: 'ZERO_CONVERSIONS' },
  { id: 'item-2', type: 'CREATIVE_FATIGUE' },
];

function build(resolved = OPEN) {
  const calls: string[] = [];
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];

  const items = {
    resolveForAd: jest.fn(async () => {
      calls.push('resolve');
      return resolved;
    }),
    recomputeDenormalization: jest.fn(async () => {
      calls.push('recompute');
    }),
  };

  const read = {
    openForAd: jest.fn(async () => {
      calls.push('read');
      return [];
    }),
  };

  const events = {
    emitFrom: jest.fn(
      (_ctx, name: string, payload: Record<string, unknown>) => {
        emitted.push({ name, payload });
        return { eventId: 'evt' };
      },
    ),
  };

  const env = { get: jest.fn().mockReturnValue(true) } as unknown as EnvService;

  return {
    useCase: new ResolveAdWasteUseCase(
      items as never,
      read as never,
      events as never,
      env,
    ),
    items,
    read,
    emitted,
    calls,
  };
}

const run = (h: ReturnType<typeof build>, body = {}) =>
  h.useCase.execute({
    organizationId: 'org-1',
    accountId: 'acc-1',
    adId: 'ad-1',
    body: {
      kind: 'RESOLVED_EXTERNALLY',
      reason: 'troquei o criativo',
      ...body,
    },
  });

describe('resolver por anúncio', () => {
  it('resolve os abertos e devolve o que foi fechado', async () => {
    const h = build();

    const result = await run(h);

    expect(result.data.resolved).toEqual([
      { id: 'item-1', type: 'ZERO_CONVERSIONS' },
      { id: 'item-2', type: 'CREATIVE_FATIGUE' },
    ]);
    expect(result.data.remainingOpen).toBe(0);
    expect(result.data.resolutionKind).toBe('RESOLVED_EXTERNALLY');
  });

  it('recalcula a denormalização ANTES de reler o estado', async () => {
    // A ordem é o ponto: reler antes de recalcular devolveria o estado de antes
    // da ação, e a tela mostraria o número que o usuário acabou de zerar.
    const h = build();

    await run(h);

    expect(h.calls).toEqual(['resolve', 'recompute', 'read']);
    expect(h.items.recomputeDenormalization).toHaveBeenCalledWith(
      ['ad-1'],
      expect.any(Date),
    );
  });

  it('emite um waste.resolved POR ITEM, não um por chamada', async () => {
    // `alerts`, `audit` e a medição de P8 contam achados resolvidos; um evento
    // agregado obrigaria cada consumidor a desempacotar uma lista para chegar
    // ao mesmo número.
    const h = build();

    await run(h);

    expect(h.emitted).toHaveLength(2);
    expect(h.emitted.map((event) => event.name)).toEqual([
      'waste.resolved',
      'waste.resolved',
    ]);
    expect(h.emitted[0].payload).toEqual({
      adId: 'ad-1',
      wasteItemId: 'item-1',
      resolutionKind: 'RESOLVED_EXTERNALLY',
    });
  });

  it('`types` restringe a resolução, e chega ao repositório', async () => {
    const h = build([OPEN[1]]);

    await run(h, { types: ['CREATIVE_FATIGUE'] });

    expect(h.items.resolveForAd).toHaveBeenCalledWith(
      expect.objectContaining({
        adId: 'ad-1',
        organizationId: 'org-1',
        types: ['CREATIVE_FATIGUE'],
      }),
    );
  });

  it('nenhum aberto é 404 — e não emite, não recalcula', async () => {
    // Anúncio de outra organização, inexistente, ou já limpo: os três respondem
    // igual. Distinguir "não é seu" de "não existe" entregaria a existência de
    // dados de outro tenant.
    const h = build([]);

    await expect(run(h)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.emitted).toEqual([]);
    expect(h.items.recomputeDenormalization).not.toHaveBeenCalled();
  });

  it('com o detector desligado, recusa com erro tipado antes de tocar no banco', async () => {
    const h = build();
    (h.useCase as unknown as { env: EnvService }).env = {
      get: jest.fn().mockReturnValue(false),
    } as unknown as EnvService;

    await expect(run(h)).rejects.toMatchObject({
      code: 'WASTE_DETECTOR_DISABLED',
      category: 'PRECONDITION_FAILED',
    });
    expect(h.items.resolveForAd).not.toHaveBeenCalled();
  });
});
