import { classifyPlatformError } from 'src/modules/platform-clients/domain/platform-error';
import {
  PlatformHttpClient,
  PlatformRequestError,
} from 'src/modules/platform-clients/infrastructure/platform-http.client';
import type {
  AdActionCommand,
  ExecutionContext,
} from 'src/modules/platform-actions/domain/contracts/action-contracts';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { MetaAdActionGateway } from './meta-ad-action.gateway';

const env = {
  get: (key: string) => (key === 'META_API_VERSION' ? 'v25.0' : undefined),
} as unknown as EnvService;

function gatewayWith(request: jest.Mock) {
  const http = { request } as unknown as PlatformHttpClient;
  return new MetaAdActionGateway(http, env);
}

const ctx: ExecutionContext = {
  idempotencyKey: 'key-1',
  integrationId: 'int-1',
  externalAccountId: 'act_123',
  accessToken: 'token-1',
  correlationId: 'corr-1',
  attempt: 1,
};

const pauseAd: AdActionCommand = {
  type: 'PAUSE_AD',
  level: 'AD',
  target: { type: 'AD', internalId: 'ad-uuid', externalId: '23847' },
  parameters: { schemaVersion: 1, adId: 'ad-uuid' },
  accountCurrency: 'BRL',
};

const budget: AdActionCommand = {
  type: 'ADJUST_AD_SET_BUDGET',
  level: 'AD_SET',
  target: { type: 'AD_SET', internalId: 'set-uuid', externalId: '99881' },
  parameters: {
    schemaVersion: 1,
    adSetId: 'set-uuid',
    dailyBudget: 150.5,
    previousDailyBudget: 99,
    currency: 'BRL',
  },
  accountCurrency: 'BRL',
};

describe('capabilities (§13.3)', () => {
  const gateway = gatewayWith(jest.fn());

  it('declara as quatro ações do subconjunto inicial como suportadas', () => {
    const supported = gateway
      .capabilities()
      .filter((c) => c.supported)
      .map((c) => c.type);

    expect(supported).toEqual(
      expect.arrayContaining([
        'PAUSE_AD',
        'ENABLE_AD',
        'ADJUST_AD_SET_BUDGET',
        'ADJUST_CAMPAIGN_BUDGET',
        'ARCHIVE_AD',
      ]),
    );
  });

  /**
   * O gate de P6: o que a plataforma não faz é **declarado com motivo**, nunca
   * omitido. Uma ação ausente da lista é indistinguível de um bug para quem
   * consome a API.
   */
  /**
   * Desde A2-S8 as treze são executáveis na Meta — a lista não tem mais
   * indisponíveis. A regra continua valendo para o que vier: toda ação sem
   * suporte declara o motivo, porque uma ação ausente da lista é
   * indistinguível de um bug para quem consome.
   */
  it('suporta as treze, e exigiria motivo de qualquer uma que não suportasse', () => {
    const capabilities = gateway.capabilities();

    expect(capabilities.filter((c) => c.supported)).toHaveLength(13);
    for (const capability of capabilities.filter((c) => !c.supported)) {
      expect(capability.unsupportedReason).toBeTruthy();
    }
  });

  it('cobre os treze tipos de ação, sem buraco', () => {
    expect(gateway.capabilities()).toHaveLength(13);
  });

  /**
   * §13.3 — na Meta, trocar copy ou criativo **cria anúncio novo e arquiva o
   * antigo**. `requiresRecreate` é o que a tela mostra antes da confirmação e o
   * que a linhagem usa depois; divergir do `PlatformProfile` faria a mesma
   * verdade ter duas respostas.
   */
  it('marca como recriadoras as ações que a Meta recria', () => {
    const recreating = gateway
      .capabilities()
      .filter((c) => c.requiresRecreate)
      .map((c) => c.type)
      .sort();

    // Só as duas que trocam **texto**: na Meta o texto vive no criativo, e
    // mudá-lo faz a plataforma substituir o anúncio. Trocar o criativo por outro
    // já existente é atualização do vínculo, e o `ad_id` permanece (§13.1).
    expect(recreating).toEqual(['REPLACE_CTA', 'REPLACE_COPY'].sort());
  });

  /**
   * A separação que A2-S8 introduziu, vista da capability: `REPLACE_CREATIVE`
   * não recria e não cria entidade — e ainda assim é a ação sobre a qual a tela
   * mais precisa avisar. O aviso vem de `ActionImpact`, no `PlatformProfile`.
   */
  it('trata troca de criativo como edição em lugar', () => {
    expect(
      gateway.capabilities().find((c) => c.type === 'REPLACE_CREATIVE'),
    ).toMatchObject({
      supported: true,
      requiresRecreate: false,
      createsEntity: false,
    });
  });

  it('traduz troca de criativo para atualização do vínculo', async () => {
    const request = jest.fn().mockResolvedValue({ data: { success: true } });

    await gatewayWith(request).execute(
      {
        ...pauseAd,
        type: 'REPLACE_CREATIVE',
        parameters: {
          schemaVersion: 1,
          adId: 'ad-uuid',
          creativeId: 'creative-9',
        },
      },
      ctx,
    );

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://graph.facebook.com/v25.0/23847',
        body: expect.objectContaining({
          creative: JSON.stringify({ creative_id: 'creative-9' }),
        }),
      }),
    );
  });

  /**
   * Duplicar **cria** sem **recriar**, e a combinação é a informação: o
   * original continua veiculando ao lado da cópia. Marcá-la como recriadora
   * faria a tela avisar que o aprendizado reinicia e a prova social zera —
   * quando nada disso acontece com o anúncio que o usuário está olhando.
   */
  it('separa criar entidade de recriar o anúncio', () => {
    const duplicate = gateway
      .capabilities()
      .find((c) => c.type === 'DUPLICATE_AD');

    expect(duplicate).toMatchObject({
      supported: true,
      createsEntity: true,
      requiresRecreate: false,
    });
  });

  it('exige validação de plataforma onde só ela sabe responder', () => {
    const adSetBudget = gateway
      .capabilities()
      .find((c) => c.type === 'ADJUST_AD_SET_BUDGET');

    // "Este conjunto está sob CBO?" não tem resposta local.
    expect(adSetBudget?.validationDepth).toBe('PLATFORM');
  });
});

describe('validate (§13.2)', () => {
  const gateway = gatewayWith(jest.fn());

  it('aprova um comando bem formado, declarando a profundidade', async () => {
    const result = await gateway.validate(pauseAd);

    expect(result.valid).toBe(true);
    // Aprovação local **não** é aprovação da plataforma, e o campo é o que
    // impede o chamador de tratar as duas como a mesma coisa.
    expect(result.depth).toBe('LOCAL_ONLY');
  });

  /**
   * M3. O schema já exige `currency` no valor; o que esta checagem pega é o
   * caso em que ele veio preenchido com a moeda-base da organização enquanto a
   * conta opera em outra — que o schema não tem como ver, porque não conhece a
   * conta. O resultado não seria um erro visível: seria um orçamento plausível
   * na moeda errada.
   */
  it('recusa orçamento em moeda diferente da conta', async () => {
    const result = await gateway.validate({
      ...budget,
      accountCurrency: 'USD',
    });

    expect(result.valid).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('CURRENCY_MISMATCH');
  });

  it('recusa orçamento não positivo', async () => {
    const result = await gateway.validate({
      ...budget,
      parameters: { ...budget.parameters, dailyBudget: 0 },
    });

    expect(result.failures.map((f) => f.code)).toContain('BUDGET_NOT_POSITIVE');
  });

  it('recusa alvo sem id na plataforma', async () => {
    const result = await gateway.validate({
      ...pauseAd,
      target: { ...pauseAd.target, externalId: '' },
    });

    expect(result.failures.map((f) => f.code)).toContain('TARGET_NOT_RESOLVED');
  });

  /**
   * O caminho de fallback: um tipo que a Meta não conhece. Nenhuma das treze
   * cai aqui hoje, e é justamente por isso que o teste usa um tipo inventado —
   * a proteção precisa existir antes da ação que a exija.
   */
  it('recusa tipo de ação que não existe no catálogo da plataforma', async () => {
    const result = await gateway.validate({
      ...pauseAd,
      type: 'ALGO_QUE_NAO_EXISTE' as never,
    });

    expect(result.failures.map((f) => f.code)).toContain('ACTION_UNSUPPORTED');
  });

  /**
   * §13.1 declara `ARCHIVE_AD` sem volta. O gateway a suporta e a marca
   * `reversible: false`; é daí que sai o aviso de irreversibilidade que a UI
   * mostra **antes** da confirmação.
   */
  it('suporta arquivar, e a declara irreversível', async () => {
    const capability = gateway
      .capabilities()
      .find((entry) => entry.type === 'ARCHIVE_AD');

    expect(capability).toMatchObject({ supported: true, reversible: false });
    expect(
      (await gateway.validate({ ...pauseAd, type: 'ARCHIVE_AD' })).valid,
    ).toBe(true);
  });
});

describe('execute', () => {
  it('traduz pausa para o POST de status da Meta', async () => {
    const request = jest.fn().mockResolvedValue({ data: { success: true } });
    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.status).toBe('SUCCEEDED');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://graph.facebook.com/v25.0/23847',
        integrationId: 'int-1',
        body: expect.objectContaining({ status: 'PAUSED' }),
        // Uma tentativa: repetir um POST que talvez tenha chegado é como um
        // orçamento é somado duas vezes.
        maxAttempts: 1,
      }),
    );
  });

  /**
   * R$ 150,50 vai como `15050`, não `150.5` nem `15054`. O resíduo binário de
   * `150.55 * 100` é o motivo de a conversão arredondar em vez de truncar.
   */
  it('envia orçamento na unidade menor da moeda da conta', async () => {
    const request = jest.fn().mockResolvedValue({ data: { success: true } });
    await gatewayWith(request).execute(budget, ctx);

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ daily_budget: '15050' }),
      }),
    );
  });

  it('devolve UNSUPPORTED sem tocar na rede quando a ação não existe aqui', async () => {
    const request = jest.fn();
    const result = await gatewayWith(request).execute(
      { ...pauseAd, type: 'ALGO_QUE_NAO_EXISTE' as never },
      ctx,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.retryable).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  /**
   * A distinção que sustenta o retry: *"tente de novo"* contra *"não adianta"*.
   * Um 400 da Meta é recusa — repetir três vezes gasta cota e adia o erro que o
   * usuário precisa ver.
   */
  it.each([
    ['bad_request', 400],
    ['permission', 403],
    ['not_found', 404],
    ['auth', 401],
  ])('classifica %s como REJECTED_BY_PLATFORM', async (_code, status) => {
    const request = jest
      .fn()
      .mockRejectedValue(
        new PlatformRequestError(classifyPlatformError({ status }), 1),
      );

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.status).toBe('REJECTED_BY_PLATFORM');
    expect(result.retryable).toBe(false);
  });

  it.each([
    ['rate_limit', 429],
    ['server_error', 500],
  ])('classifica %s como FAILED reexecutável', async (_code, status) => {
    const request = jest
      .fn()
      .mockRejectedValue(
        new PlatformRequestError(classifyPlatformError({ status }), 1),
      );

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.status).toBe('FAILED');
    expect(result.retryable).toBe(true);
  });

  /**
   * §9.5 passo 6 — o id novo é o que casa a linhagem no ingest seguinte. Sem
   * ele, o outcome mede o anúncio antigo e lê "gasto foi a zero" como sucesso
   * absoluto, quando o gasto só saiu do campo de visão.
   */
  it('captura o id novo quando a plataforma recria a entidade', async () => {
    const request = jest.fn().mockResolvedValue({ data: { id: '77777' } });
    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.platformEntityId).toBe('77777');
  });

  it('não confunde o eco do id do alvo com entidade nova', async () => {
    const request = jest.fn().mockResolvedValue({ data: { id: '23847' } });
    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.platformEntityId).toBeUndefined();
  });
});

describe('DUPLICATE_AD', () => {
  /**
   * Uma duplicata que começa a veicular no instante em que é criada dobra o
   * gasto do anúncio sem que ninguém tenha confirmado o orçamento dela. O
   * usuário liga depois, olhando — que é a ordem que R1 pede.
   */
  it('cria a cópia pausada, sempre', async () => {
    const request = jest
      .fn()
      .mockResolvedValue({ data: { copied_ad_id: '99999' } });

    await gatewayWith(request).execute(
      { ...pauseAd, type: 'DUPLICATE_AD' },
      ctx,
    );

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://graph.facebook.com/v25.0/23847/copies',
        body: expect.objectContaining({ status_option: 'PAUSED' }),
      }),
    );
  });

  it('devolve o id da cópia para o ingest casar depois', async () => {
    const request = jest
      .fn()
      .mockResolvedValue({ data: { copied_ad_id: '99999' } });

    const result = await gatewayWith(request).execute(
      { ...pauseAd, type: 'DUPLICATE_AD' },
      ctx,
    );

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      platformEntityId: '99999',
    });
  });

  it('aceita o campo alternativo que a Meta usa conforme a versão', async () => {
    const request = jest
      .fn()
      .mockResolvedValue({ data: { ad_object_id: '88888' } });

    const result = await gatewayWith(request).execute(
      { ...pauseAd, type: 'DUPLICATE_AD' },
      ctx,
    );

    expect(result.platformEntityId).toBe('88888');
  });

  /**
   * Sem id de volta não há como ligar a cópia a esta execução, e o ingest
   * seguinte a descobriria como anúncio anônimo. `FAILED`, não `SUCCEEDED`: a
   * Meta pode ter criado, e é justamente por não sabermos que a verificação
   * precisa acontecer em vez da confirmação.
   */
  it('não declara sucesso sem o id da cópia', async () => {
    const request = jest.fn().mockResolvedValue({ data: { success: true } });

    const result = await gatewayWith(request).execute(
      { ...pauseAd, type: 'DUPLICATE_AD' },
      ctx,
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      errorCode: 'COPY_ID_MISSING',
      retryable: false,
    });
  });

  it('traduz a recusa de campanha Advantage+ como recusa da plataforma', async () => {
    const request = jest
      .fn()
      .mockRejectedValue(
        new PlatformRequestError(classifyPlatformError({ status: 400 }), 1),
      );

    const result = await gatewayWith(request).execute(
      { ...pauseAd, type: 'DUPLICATE_AD' },
      ctx,
    );

    expect(result.status).toBe('REJECTED_BY_PLATFORM');
  });
});

describe('REPLACE_COPY / REPLACE_CTA — composição de criativo', () => {
  const replaceCopy: AdActionCommand = {
    ...pauseAd,
    type: 'REPLACE_COPY',
    parameters: {
      schemaVersion: 1,
      adId: 'ad-uuid',
      primaryText: 'Texto revisado',
      aiAuthored: true,
    },
  };

  /** Um anúncio veiculando, com criativo composto por `link_data`. */
  function metaSequence(overrides: { effectiveStatus?: string } = {}) {
    return jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          name: 'Anúncio A',
          adset_id: '99881',
          effective_status: overrides.effectiveStatus ?? 'ACTIVE',
          creative: {
            id: 'cre-1',
            object_story_spec: {
              page_id: 'p1',
              link_data: { message: 'Texto antigo', link: 'https://x' },
            },
          },
        },
      })
      .mockResolvedValueOnce({ data: { id: 'cre-2' } })
      .mockResolvedValueOnce({ data: { id: 'ad-novo' } })
      .mockResolvedValueOnce({ data: { success: true } })
      .mockResolvedValueOnce({ data: { success: true } });
  }

  const urlsOf = (request: jest.Mock) =>
    request.mock.calls.map(
      (call) => call[0] as { url: string; body?: unknown },
    );

  /**
   * **A ordem é a proteção.** Criar o novo já ligado e só então desligar o
   * antigo deixaria os dois veiculando se a última chamada falhasse — gasto
   * dobrado, que é exatamente R1. Aqui o novo nasce pausado, o antigo é parado,
   * e só então o novo é ligado.
   */
  it('cria pausado, para o antigo, e só então liga o novo', async () => {
    const request = metaSequence();

    const result = await gatewayWith(request).execute(replaceCopy, ctx);

    const calls = urlsOf(request);
    expect(calls[1].url).toContain('/act_123/adcreatives');
    expect(calls[2].url).toContain('/act_123/ads');
    expect(calls[2].body).toMatchObject({ status: 'PAUSED' });
    // o antigo
    expect(calls[3].url).toContain('/23847');
    expect(calls[3].body).toMatchObject({ status: 'PAUSED' });
    // o novo
    expect(calls[4].url).toContain('/ad-novo');
    expect(calls[4].body).toMatchObject({ status: 'ACTIVE' });
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      platformEntityId: 'ad-novo',
    });
  });

  it('copia o spec inteiro e troca só o texto', async () => {
    const request = metaSequence();
    await gatewayWith(request).execute(replaceCopy, ctx);

    const spec = JSON.parse(
      (urlsOf(request)[1].body as { object_story_spec: string })
        .object_story_spec,
    ) as { page_id: string; link_data: { message: string; link: string } };

    expect(spec.link_data.message).toBe('Texto revisado');
    // O resto do criativo sobrevive: perder o link ao trocar a copy publicaria
    // um anúncio que não leva a lugar nenhum.
    expect(spec.link_data.link).toBe('https://x');
    expect(spec.page_id).toBe('p1');
  });

  it('troca o CTA sem tocar na mensagem', async () => {
    const request = metaSequence();
    await gatewayWith(request).execute(
      {
        ...replaceCopy,
        type: 'REPLACE_CTA',
        parameters: {
          schemaVersion: 1,
          adId: 'ad-uuid',
          callToAction: 'SHOP_NOW',
          aiAuthored: false,
        },
      },
      ctx,
    );

    const spec = JSON.parse(
      (urlsOf(request)[1].body as { object_story_spec: string })
        .object_story_spec,
    ) as { link_data: { message: string; call_to_action: { type: string } } };

    expect(spec.link_data.call_to_action.type).toBe('SHOP_NOW');
    expect(spec.link_data.message).toBe('Texto antigo');
  });

  /**
   * Um anúncio ativo dentro de conjunto pausado não está entregando. Religar o
   * substituto o colocaria a veicular onde o original não veiculava — gasto que
   * ninguém pediu.
   */
  it('não liga o substituto se o original não estava entregando', async () => {
    const request = metaSequence({ effectiveStatus: 'ADSET_PAUSED' });

    await gatewayWith(request).execute(replaceCopy, ctx);

    expect(request).toHaveBeenCalledTimes(4);
    expect(urlsOf(request)[3].body).toMatchObject({ status: 'PAUSED' });
  });

  /**
   * A partir da criação do anúncio novo existe entidade no ar. Perder o id numa
   * falha posterior o deixaria órfão: pausado, invisível para a linhagem, e
   * descoberto pelo ingest como anúncio sem origem.
   */
  it('carrega o id do anúncio criado mesmo quando falha depois', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          name: 'Anúncio A',
          adset_id: '99881',
          effective_status: 'ACTIVE',
          creative: { id: 'cre-1', object_story_spec: { link_data: {} } },
        },
      })
      .mockResolvedValueOnce({ data: { id: 'cre-2' } })
      .mockResolvedValueOnce({ data: { id: 'ad-novo' } })
      .mockRejectedValueOnce(
        new PlatformRequestError(classifyPlatformError({ status: 500 }), 1),
      );

    const result = await gatewayWith(request).execute(replaceCopy, ctx);

    expect(result.status).toBe('FAILED');
    expect(result.platformEntityId).toBe('ad-novo');
  });

  it('recusa sem tocar na rede quando o criativo não é componível', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ data: { name: 'A', adset_id: '99881' } });

    const result = await gatewayWith(request).execute(replaceCopy, ctx);

    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      errorCode: 'CREATIVE_NOT_COMPOSABLE',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('revert (§9.6)', () => {
  it('restaura o status registrado antes da escrita', async () => {
    const request = jest.fn().mockResolvedValue({ data: { success: true } });
    const result = await gatewayWith(request).revert(
      pauseAd,
      { status: 'ACTIVE' },
      ctx,
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });

  it('restaura o orçamento exatamente como estava, na unidade da plataforma', async () => {
    const request = jest.fn().mockResolvedValue({ data: { success: true } });
    await gatewayWith(request).revert(
      budget,
      { dailyBudgetMinor: '9900' },
      ctx,
    );

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ daily_budget: '9900' }),
      }),
    );
  });

  /**
   * **Reverter sem estado anterior é inventar um estado.** Um default aqui
   * restauraria algo que nunca existiu, e o usuário leria "revertido" sobre uma
   * terceira escrita arbitrária.
   */
  it('recusa reverter sem estado anterior', async () => {
    const request = jest.fn();
    const result = await gatewayWith(request).revert(pauseAd, null, ctx);

    expect(result.status).toBe('UNSUPPORTED');
    expect(result.errorCode).toBe('PREVIOUS_STATE_MISSING');
    expect(request).not.toHaveBeenCalled();
  });

  it('recusa reverter quando o estado anterior não tem o campo que mudou', async () => {
    const request = jest.fn();
    const result = await gatewayWith(request).revert(
      budget,
      { status: 'ACTIVE' },
      ctx,
    );

    expect(result.errorCode).toBe('PREVIOUS_STATE_INCOMPLETE');
    expect(request).not.toHaveBeenCalled();
  });
});

describe('observe', () => {
  /**
   * `effective_status` antes de `status`: um anúncio ativo dentro de um
   * conjunto pausado responde `status: ACTIVE` — e confirmaria uma escrita que
   * não teve efeito nenhum sobre a entrega.
   */
  it('prefere effective_status ao status configurado', async () => {
    const request = jest.fn().mockResolvedValue({
      data: { id: '23847', status: 'ACTIVE', effective_status: 'ADSET_PAUSED' },
    });

    const state = await gatewayWith(request).observe(pauseAd, ctx);

    expect(state.status).toBe('ADSET_PAUSED');
  });

  it('lê o orçamento em unidade menor, sem converter', async () => {
    const request = jest.fn().mockResolvedValue({
      data: { id: '99881', status: 'ACTIVE', daily_budget: '15050' },
    });

    const state = await gatewayWith(request).observe(budget, ctx);

    // A conversão é do chamador, que sabe a moeda da conta. Converter aqui
    // exigiria que o gateway a conhecesse — e ele recebe o comando, não a conta.
    expect(state.dailyBudgetMinor).toBe('15050');
  });
});
