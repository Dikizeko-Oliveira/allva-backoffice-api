import { classifyPlatformError } from 'src/modules/platform-clients/domain/platform-error';
import {
  PlatformHttpClient,
  PlatformRequestError,
} from 'src/modules/platform-clients/infrastructure/platform-http.client';
import type {
  AdActionCommand,
  ExecutionContext,
} from 'src/modules/platform-actions/domain/contracts/action-contracts';
import { TikTokAdActionGateway } from './tiktok-ad-action.gateway';

function gatewayWith(request: jest.Mock) {
  return new TikTokAdActionGateway({
    request,
  } as unknown as PlatformHttpClient);
}

const ctx: ExecutionContext = {
  idempotencyKey: 'key-1',
  integrationId: 'int-1',
  externalAccountId: '7000',
  accessToken: 'token-1',
  correlationId: null,
  attempt: 1,
};

const pauseAd: AdActionCommand = {
  type: 'PAUSE_AD',
  level: 'AD',
  target: { type: 'AD', internalId: 'ad-uuid', externalId: '17800' },
  parameters: { schemaVersion: 1, adId: 'ad-uuid' },
  accountCurrency: 'BRL',
};

const budget: AdActionCommand = {
  type: 'ADJUST_AD_SET_BUDGET',
  level: 'AD_SET',
  target: { type: 'AD_SET', internalId: 'set-uuid', externalId: '9900' },
  parameters: {
    schemaVersion: 1,
    adSetId: 'set-uuid',
    dailyBudget: 150.5,
    previousDailyBudget: 99,
    currency: 'BRL',
  },
  accountCurrency: 'BRL',
};

const campaignBudget: AdActionCommand = {
  ...budget,
  type: 'ADJUST_CAMPAIGN_BUDGET',
  level: 'CAMPAIGN',
  target: { type: 'CAMPAIGN', internalId: 'c', externalId: '5500' },
  parameters: {
    schemaVersion: 1,
    campaignId: 'c',
    dailyBudget: 300,
    previousDailyBudget: 99,
    currency: 'BRL',
  },
};

const ok = (data: unknown = {}) => ({ data: { code: 0, data } });
const entity = (node: Record<string, unknown>) => ok({ list: [node] });
const callOf = (request: jest.Mock, index = 0) =>
  request.mock.calls[index][0] as {
    url: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  };

describe('capabilities do TikTok (§13.1)', () => {
  const gateway = gatewayWith(jest.fn());

  it('cobre os treze tipos, sem buraco', () => {
    expect(gateway.capabilities()).toHaveLength(13);
  });

  it('pausa e reativa nos três níveis, como a Meta', () => {
    const supported = gateway
      .capabilities()
      .filter((c) => c.supported)
      .map((c) => c.type);

    expect(supported).toEqual(
      expect.arrayContaining([
        'PAUSE_AD',
        'ENABLE_AD',
        'PAUSE_AD_SET',
        'ENABLE_AD_SET',
        'PAUSE_CAMPAIGN',
        'ENABLE_CAMPAIGN',
      ]),
    );
  });

  /**
   * A diferença com o Google que o `PlatformProfile` já declarava: o TikTok
   * **tem** orçamento no grupo de anúncios.
   */
  it('suporta orçamento no grupo de anúncios, ao contrário do Google', () => {
    expect(
      gateway.capabilities().find((c) => c.type === 'ADJUST_AD_SET_BUDGET'),
    ).toMatchObject({ supported: true });
  });

  it('declara arquivamento irreversível', () => {
    expect(
      gateway.capabilities().find((c) => c.type === 'ARCHIVE_AD'),
    ).toMatchObject({ supported: true, reversible: false });
  });

  it('duplica e troca texto e CTA; não troca criativo', () => {
    const byType = new Map(gateway.capabilities().map((c) => [c.type, c]));

    expect(byType.get('DUPLICATE_AD')).toMatchObject({
      supported: true,
      createsEntity: true,
      requiresRecreate: false,
    });
    expect(byType.get('REPLACE_COPY')).toMatchObject({
      supported: true,
      requiresRecreate: true,
    });
    expect(byType.get('REPLACE_CTA')).toMatchObject({
      supported: true,
      requiresRecreate: true,
    });
    expect(byType.get('REPLACE_CREATIVE')?.supported).toBe(false);
  });

  it('declara motivo para toda ação não suportada, sem dizer que é igual nas três', () => {
    for (const capability of gateway
      .capabilities()
      .filter((c) => !c.supported)) {
      expect(capability.unsupportedReason).toBeTruthy();
      expect(capability.unsupportedReason).not.toContain('mesmo subconjunto');
    }
  });
});

describe('execute', () => {
  it('muda status por /ad/status/update/ com o advertiser', async () => {
    const request = jest.fn().mockResolvedValue(ok());

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.status).toBe('SUCCEEDED');
    const call = callOf(request);
    expect(call.url).toContain('/open_api/v1.3/ad/status/update/');
    expect(call.headers).toMatchObject({ 'Access-Token': 'token-1' });
    expect(call.body).toMatchObject({
      advertiser_id: '7000',
      ad_ids: ['17800'],
      operation_status: 'DISABLE',
    });
  });

  it('pausa grupo de anúncios pelo endpoint do grupo', async () => {
    const request = jest.fn().mockResolvedValue(ok());

    await gatewayWith(request).execute(
      {
        ...pauseAd,
        type: 'PAUSE_AD_SET',
        level: 'AD_SET',
        target: budget.target,
      },
      ctx,
    );

    expect(callOf(request).url).toContain('/adgroup/status/update/');
    expect(callOf(request).body).toMatchObject({
      adgroup_ids: ['9900'],
      operation_status: 'DISABLE',
    });
  });

  it('reativa campanha pelo endpoint da campanha', async () => {
    const request = jest.fn().mockResolvedValue(ok());

    await gatewayWith(request).execute(
      {
        ...pauseAd,
        type: 'ENABLE_CAMPAIGN',
        level: 'CAMPAIGN',
        target: campaignBudget.target,
      },
      ctx,
    );

    expect(callOf(request).url).toContain('/campaign/status/update/');
    expect(callOf(request).body).toMatchObject({
      campaign_ids: ['5500'],
      operation_status: 'ENABLE',
    });
  });

  it('arquiva como DELETE', async () => {
    const request = jest.fn().mockResolvedValue(ok());

    await gatewayWith(request).execute({ ...pauseAd, type: 'ARCHIVE_AD' }, ctx);

    expect(callOf(request).body).toMatchObject({ operation_status: 'DELETE' });
  });

  /**
   * Três plataformas, três escalas: micros no Google, unidade menor na Meta, e
   * número puro na moeda da conta aqui. E o modo do orçamento é conferido antes:
   * a chamada é a mesma para diário e total.
   */
  it('confere o budget_mode e envia orçamento como número na moeda da conta', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        entity({ budget_mode: 'BUDGET_MODE_DAY', budget: 99 }),
      )
      .mockResolvedValueOnce(ok());

    const result = await gatewayWith(request).execute(budget, ctx);

    expect(result.status).toBe('SUCCEEDED');
    expect(callOf(request, 0).url).toContain('/adgroup/get/');
    expect(decodeURIComponent(callOf(request, 0).url)).toContain(
      '"adgroup_ids":["9900"]',
    );
    expect(callOf(request, 1).url).toContain('/adgroup/update/');
    expect(callOf(request, 1).body).toMatchObject({
      adgroup_id: '9900',
      budget: 150.5,
    });
  });

  it('usa os endpoints de campanha para orçamento de campanha', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        entity({ budget_mode: 'BUDGET_MODE_DAY', budget: 99 }),
      )
      .mockResolvedValueOnce(ok());

    await gatewayWith(request).execute(campaignBudget, ctx);

    expect(callOf(request, 0).url).toContain('/campaign/get/');
    expect(callOf(request, 1).url).toContain('/campaign/update/');
    expect(callOf(request, 1).body).toMatchObject({ campaign_id: '5500' });
  });

  /**
   * Gravar um valor "diário" num objeto com orçamento de voo mudaria o total da
   * campanha inteira — e a API aceitaria.
   */
  it('recusa orçamento total sem escrever', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(
        entity({ budget_mode: 'BUDGET_MODE_TOTAL', budget: 5000 }),
      );

    const result = await gatewayWith(request).execute(budget, ctx);

    expect(result).toMatchObject({
      status: 'REJECTED_BY_PLATFORM',
      errorCode: 'BUDGET_NOT_DAILY',
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('recusa quando não há orçamento próprio (ilimitado)', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(entity({ budget_mode: 'BUDGET_MODE_INFINITE' }));

    const result = await gatewayWith(request).execute(campaignBudget, ctx);

    expect(result.errorCode).toBe('BUDGET_NOT_DAILY');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

/**
 * **O caso que define este gateway.** O TikTok responde `HTTP 200` mesmo quando
 * recusa, e o erro vem em `code != 0`.
 */
describe('erro que chega como HTTP 200', () => {
  it('não declara sucesso quando o corpo traz code != 0', async () => {
    const request = jest.fn().mockResolvedValue({
      data: { code: 40002, message: 'Invalid ad status transition' },
    });

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.status).toBe('REJECTED_BY_PLATFORM');
    expect(result.errorCode).toBe('tiktok_40002');
    expect(result.errorMessage).toBe('Invalid ad status transition');
    expect(result.retryable).toBe(false);
  });

  it('separa falha do servidor de recusa do pedido', async () => {
    const server = jest
      .fn()
      .mockResolvedValue({ data: { code: 50000, message: 'Internal' } });

    const result = await gatewayWith(server).execute(pauseAd, ctx);

    expect(result.status).toBe('FAILED');
    expect(result.retryable).toBe(true);
  });

  it('trata código desconhecido como recusa, não como falha temporária', async () => {
    const request = jest.fn().mockResolvedValue({ data: {} });

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.status).toBe('REJECTED_BY_PLATFORM');
    expect(result.retryable).toBe(false);
  });

  it('ainda classifica falha de transporte quando nem envelope houve', async () => {
    const request = jest
      .fn()
      .mockRejectedValue(
        new PlatformRequestError(classifyPlatformError({ status: 500 }), 1),
      );

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result).toMatchObject({ status: 'FAILED', retryable: true });
  });
});

describe('observe', () => {
  it('lê o status pelo filtro de ids', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(ok({ list: [{ operation_status: 'DISABLE' }] }));

    const state = await gatewayWith(request).observe(pauseAd, ctx);

    expect(state.status).toBe('DISABLE');
    expect(callOf(request).url).toContain('/ad/get/');
    expect(callOf(request).url).toContain('filtering=');
  });

  it('prefere o status de entrega ao liga/desliga — o mesmo que o sync grava', async () => {
    const request = jest.fn().mockResolvedValue(
      entity({
        operation_status: 'ENABLE',
        secondary_status: 'AD_STATUS_CAMPAIGN_DISABLE',
      }),
    );

    const state = await gatewayWith(request).observe(pauseAd, ctx);

    expect(state.status).toBe('AD_STATUS_CAMPAIGN_DISABLE');
  });

  /**
   * A leitura era sempre `/ad/get/`, também para grupo e campanha — e o estado
   * anterior de todo ajuste de orçamento saía vazio.
   */
  it('lê grupo de anúncios no endpoint do grupo, com orçamento em unidade menor', async () => {
    const request = jest.fn().mockResolvedValue(
      entity({
        operation_status: 'ENABLE',
        secondary_status: 'ADGROUP_STATUS_DELIVERY_OK',
        budget_mode: 'BUDGET_MODE_DAY',
        budget: 150.5,
      }),
    );

    const state = await gatewayWith(request).observe(budget, ctx);

    expect(callOf(request).url).toContain('/adgroup/get/');
    expect(state).toMatchObject({
      status: 'ADGROUP_STATUS_DELIVERY_OK',
      dailyBudgetMinor: '15050',
      lifetimeBudgetMinor: null,
    });
  });

  /**
   * Leitura recusada devolve estado **nulo**, não um estado inventado: a escada
   * lê `null` como `INCONCLUSIVE` e pergunta de novo.
   */
  it('devolve estado nulo quando a leitura vem com erro no corpo', async () => {
    const request = jest
      .fn()
      .mockResolvedValue({ data: { code: 40100, message: 'no permission' } });

    expect(
      (await gatewayWith(request).observe(pauseAd, ctx)).status,
    ).toBeNull();
  });
});

describe('revert', () => {
  it('restaura o status capturado antes', async () => {
    const request = jest.fn().mockResolvedValue(ok());

    await gatewayWith(request).revert(pauseAd, { status: 'ENABLE' }, ctx);

    expect(callOf(request).body).toMatchObject({ operation_status: 'ENABLE' });
  });

  it('usa o liga/desliga do próprio objeto, não o status de entrega', async () => {
    const request = jest.fn().mockResolvedValue(ok());

    await gatewayWith(request).revert(
      pauseAd,
      {
        status: 'AD_STATUS_CAMPAIGN_DISABLE',
        raw: { operation_status: 'ENABLE' },
      },
      ctx,
    );

    expect(callOf(request).body).toMatchObject({ operation_status: 'ENABLE' });
  });

  it('restaura orçamento a partir da unidade menor', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        entity({ budget_mode: 'BUDGET_MODE_DAY', budget: 150.5 }),
      )
      .mockResolvedValueOnce(ok());

    await gatewayWith(request).revert(
      budget,
      { status: 'ENABLE', dailyBudgetMinor: '9900' },
      ctx,
    );

    expect(callOf(request, 1).body).toMatchObject({
      adgroup_id: '9900',
      budget: 99,
    });
  });

  it('recusa restaurar a partir de um anúncio excluído', async () => {
    const request = jest.fn();

    const result = await gatewayWith(request).revert(
      pauseAd,
      { status: 'DELETE' },
      ctx,
    );

    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      errorCode: 'IRREVERSIBLE_STATE',
    });
    expect(request).not.toHaveBeenCalled();
  });
});

/** Sem espera real entre tentativas de pausa. */
class NoWaitTikTokGateway extends TikTokAdActionGateway {
  protected wait = () => Promise.resolve();
}

type FakeOptions = {
  source?: Record<string, unknown>;
  /** A criação ignora `DISABLE` e nasce ligada. */
  createsEnabled?: boolean;
  /** A criação recusa o parâmetro `operation_status`. */
  rejectsOperationStatusOnCreate?: boolean;
  /** Ids cuja pausa a plataforma aceita e não aplica. */
  stuck?: string[];
  createFails?: 'TRANSPORT';
};

/**
 * Um TikTok com estado: lê, cria e muda status como a plataforma — é o que
 * permite testar a sequência inteira, e não uma chamada de cada vez.
 */
function fakeTikTok(options: FakeOptions = {}) {
  const source = {
    ad_id: '17800',
    adgroup_id: 'g1',
    ad_name: 'Promo',
    ad_text: 'Texto atual do anúncio',
    call_to_action: 'SHOP_NOW',
    video_id: 'v1',
    identity_type: 'CUSTOMIZED_USER',
    identity_id: 'id1',
    operation_status: 'ENABLE',
    secondary_status: 'AD_STATUS_DELIVERY_OK',
    create_time: '2026-09-01 10:00:00',
    ...options.source,
  };
  const statuses = new Map<string, string>([
    [source.ad_id, source.operation_status],
  ]);
  const creates: Array<Record<string, unknown>> = [];
  const statusUpdates: Array<{ ids: string[]; operation: string }> = [];
  let createCount = 0;

  const request = jest.fn(
    (req: { url: string; body?: Record<string, unknown> }) => {
      const url = new URL(req.url);

      if (url.pathname.endsWith('/ad/get/')) {
        const filtering = JSON.parse(
          url.searchParams.get('filtering') ?? '{}',
        ) as { ad_ids?: string[] };
        const id = filtering.ad_ids?.[0] ?? '';
        if (!statuses.has(id)) return Promise.resolve(ok({ list: [] }));

        const node =
          id === source.ad_id
            ? { ...source, operation_status: statuses.get(id) }
            : { ad_id: id, operation_status: statuses.get(id) };
        return Promise.resolve(ok({ list: [node] }));
      }

      if (url.pathname.endsWith('/ad/create/')) {
        if (options.createFails === 'TRANSPORT') {
          return Promise.reject(
            new PlatformRequestError(classifyPlatformError({ status: 500 }), 1),
          );
        }

        const creative = (
          req.body?.creatives as Array<Record<string, unknown>>
        )[0];
        creates.push(creative);

        if (
          options.rejectsOperationStatusOnCreate &&
          creative.operation_status !== undefined
        ) {
          return Promise.resolve({
            data: { code: 40002, message: 'operation_status is invalid' },
          });
        }

        createCount += 1;
        const id = `99${createCount}`;
        statuses.set(
          id,
          options.createsEnabled
            ? 'ENABLE'
            : ((creative.operation_status as string | undefined) ?? 'ENABLE'),
        );
        return Promise.resolve(ok({ ad_ids: [id] }));
      }

      if (url.pathname.endsWith('/ad/status/update/')) {
        const ids = req.body?.ad_ids as string[];
        const operation = req.body?.operation_status as string;
        statusUpdates.push({ ids, operation });
        for (const id of ids) {
          if (!options.stuck?.includes(id)) statuses.set(id, operation);
        }
        return Promise.resolve(ok());
      }

      return Promise.resolve(ok());
    },
  );

  return {
    gateway: new NoWaitTikTokGateway({
      request,
    } as unknown as PlatformHttpClient),
    request,
    creates,
    statusUpdates,
    statuses,
  };
}

const duplicate: AdActionCommand = { ...pauseAd, type: 'DUPLICATE_AD' };

/**
 * A regra: uma ação da Allva nunca aumenta gasto em silêncio. O estado final de
 * duplicar é "duplicado e pausado" — não "o TikTok aceitou a criação".
 */
describe('DUPLICATE_AD no TikTok', () => {
  it('cria pedindo DISABLE e só conclui com a pausa lida de volta', async () => {
    const fake = fakeTikTok();

    const result = await fake.gateway.execute(duplicate, ctx);

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      platformEntityId: '991',
    });
    expect(fake.creates[0]).toMatchObject({
      ad_name: 'Promo — cópia',
      ad_text: 'Texto atual do anúncio',
      video_id: 'v1',
      operation_status: 'DISABLE',
    });
    // Campos de saída não são reenviados.
    expect(fake.creates[0]).not.toHaveProperty('ad_id');
    expect(fake.creates[0]).not.toHaveProperty('create_time');
    expect(fake.creates[0]).not.toHaveProperty('secondary_status');
    expect(fake.statusUpdates).toEqual([]);
  });

  it('pausa em seguida quando a plataforma cria ligada', async () => {
    const fake = fakeTikTok({ createsEnabled: true });

    const result = await fake.gateway.execute(duplicate, ctx);

    expect(result.status).toBe('SUCCEEDED');
    expect(fake.statusUpdates).toEqual([
      { ids: ['991'], operation: 'DISABLE' },
    ]);
    expect(fake.statuses.get('991')).toBe('DISABLE');
  });

  it('refaz a criação sem operation_status quando a plataforma o recusa', async () => {
    const fake = fakeTikTok({ rejectsOperationStatusOnCreate: true });

    const result = await fake.gateway.execute(duplicate, ctx);

    expect(result.status).toBe('SUCCEEDED');
    expect(fake.creates).toHaveLength(2);
    expect(fake.creates[1]).not.toHaveProperty('operation_status');
    expect(fake.statuses.get('991')).toBe('DISABLE');
  });

  /**
   * O caso que não pode ser `FAILED` nem `SUCCEEDED`: a cópia existe e pode estar
   * veiculando. Vira alerta crítico pelo `exposureRisk`.
   */
  it('pausa não confirmada é PARTIALLY_COMPLETED com risco de exposição', async () => {
    const fake = fakeTikTok({ createsEnabled: true, stuck: ['991'] });

    const result = await fake.gateway.execute(duplicate, ctx);

    expect(result).toMatchObject({
      status: 'PARTIALLY_COMPLETED',
      exposureRisk: true,
      platformEntityId: '991',
      errorCode: 'COPY_PAUSE_UNCONFIRMED',
      retryable: false,
    });
    // Pausar é idempotente: insiste antes de desistir.
    expect(fake.statusUpdates).toHaveLength(3);
  });

  it('recusa anúncio de criativo automático sem criar nada', async () => {
    const fake = fakeTikTok({ source: { is_aco: true } });

    const result = await fake.gateway.execute(duplicate, ctx);

    expect(result.errorCode).toBe('AD_TYPE_UNSUPPORTED');
    expect(fake.creates).toEqual([]);
  });

  /** A criação pode ter acontecido do outro lado: repetir criaria outra cópia. */
  it('falha de transporte na criação não volta à fila', async () => {
    const fake = fakeTikTok({ createFails: 'TRANSPORT' });

    const result = await fake.gateway.execute(duplicate, ctx);

    expect(result).toMatchObject({ status: 'FAILED', retryable: false });
    expect(result.errorMessage).toContain('confira a conta');
  });
});

const replaceCopy = (primaryText: string): AdActionCommand => ({
  type: 'REPLACE_COPY',
  level: 'AD',
  target: pauseAd.target,
  parameters: {
    schemaVersion: 1,
    adId: 'ad-uuid',
    aiAuthored: true,
    primaryText,
  },
  accountCurrency: 'BRL',
});

/**
 * Recriação na mesma ordem da Meta: o novo nasce pausado, o antigo é pausado, e
 * só então o novo é ligado — se o antigo entregava.
 */
describe('REPLACE_COPY e REPLACE_CTA no TikTok', () => {
  it('recria com o texto novo, pausa o antigo e liga o novo', async () => {
    const fake = fakeTikTok();

    const result = await fake.gateway.execute(
      replaceCopy('Um texto novo com mais de doze letras'),
      ctx,
    );

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      platformEntityId: '991',
    });
    expect(fake.creates[0]).toMatchObject({
      ad_text: 'Um texto novo com mais de doze letras',
      ad_name: 'Promo — texto revisado',
      operation_status: 'DISABLE',
    });
    expect(fake.statusUpdates).toEqual([
      { ids: ['17800'], operation: 'DISABLE' },
      { ids: ['991'], operation: 'ENABLE' },
    ]);
  });

  it('não liga o novo quando o antigo não entregava', async () => {
    const fake = fakeTikTok({
      source: {
        operation_status: 'DISABLE',
        secondary_status: 'AD_STATUS_DISABLE',
      },
    });

    const result = await fake.gateway.execute(
      replaceCopy('Um texto novo com mais de doze letras'),
      ctx,
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(fake.statusUpdates.some((u) => u.operation === 'ENABLE')).toBe(
      false,
    );
    expect(fake.statuses.get('991')).toBe('DISABLE');
  });

  /** O novo está pausado e o antigo segue como estava: nada gasta a mais. */
  it('para com o novo pausado e sem risco quando o antigo não pausa', async () => {
    const fake = fakeTikTok({ stuck: ['17800'] });

    const result = await fake.gateway.execute(
      replaceCopy('Um texto novo com mais de doze letras'),
      ctx,
    );

    expect(result).toMatchObject({
      status: 'PARTIALLY_COMPLETED',
      exposureRisk: false,
      errorCode: 'REPLACE_OLD_NOT_PAUSED',
      platformEntityId: '991',
    });
    expect(fake.statusUpdates.some((u) => u.operation === 'ENABLE')).toBe(
      false,
    );
  });

  it('recusa texto abaixo do piso do TikTok sem tocar na rede', async () => {
    const fake = fakeTikTok();

    const result = await fake.gateway.execute(replaceCopy('curto'), ctx);

    expect(result.errorCode).toBe('COPY_LENGTH_INVALID');
    expect(fake.request).not.toHaveBeenCalled();
  });

  it('troca o CTA recriando, com o valor do enum', async () => {
    const fake = fakeTikTok();

    const result = await fake.gateway.execute(
      {
        ...replaceCopy('x'),
        type: 'REPLACE_CTA',
        parameters: {
          schemaVersion: 1,
          adId: 'ad-uuid',
          aiAuthored: true,
          callToAction: 'LEARN_MORE',
        },
      },
      ctx,
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(fake.creates[0]).toMatchObject({ call_to_action: 'LEARN_MORE' });
  });

  it('recusa CTA fora do enum sem tocar na rede', async () => {
    const fake = fakeTikTok();

    const result = await fake.gateway.execute(
      {
        ...replaceCopy('x'),
        type: 'REPLACE_CTA',
        parameters: {
          schemaVersion: 1,
          adId: 'ad-uuid',
          aiAuthored: true,
          callToAction: 'Compre já',
        },
      },
      ctx,
    );

    expect(result.errorCode).toBe('COPY_LENGTH_INVALID');
    expect(fake.request).not.toHaveBeenCalled();
  });
});
