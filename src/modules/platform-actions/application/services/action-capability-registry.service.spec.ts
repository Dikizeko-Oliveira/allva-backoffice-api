import type { AdActionCapability } from 'src/modules/platform-actions/domain/contracts/action-contracts';
import { AdActionGateway } from 'src/modules/platform-actions/domain/ports/ad-action.gateway';
import type { ActionTargetView } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { permissionFor } from 'src/modules/platform-actions/domain/rbac/action-permissions';
import { GoogleAdActionGateway } from 'src/modules/platform-actions/infrastructure/providers/google/google-ad-action.gateway';
import { TikTokAdActionGateway } from 'src/modules/platform-actions/infrastructure/providers/tiktok/tiktok-ad-action.gateway';
import { ActionCapabilityRegistryService } from './action-capability-registry.service';

function capability(
  overrides: Partial<AdActionCapability> & Pick<AdActionCapability, 'type'>,
): AdActionCapability {
  return {
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
    ...overrides,
  };
}

function gatewayFor(
  platform: 'META' | 'GOOGLE',
  capabilities: AdActionCapability[],
): AdActionGateway {
  return {
    platform,
    capabilities: () => capabilities,
  } as unknown as AdActionGateway;
}

const target: ActionTargetView = {
  adId: 'ad-1',
  organizationId: 'org-1',
  accountId: 'acc-1',
  platform: 'META',
  adAccountId: 'adacc-1',
  integrationId: 'int-1',
  accountCurrency: 'BRL',
  externalAccountId: 'act_1',
  externalAdId: '23847',
  unitKind: 'AD',
  creativeFormat: null,
  observedStatus: 'ACTIVE',
  desiredStatus: null,
  syncState: 'IN_SYNC',
  version: 3,
  adSet: { id: 'set-1', externalId: '99881' },
  campaign: { id: 'camp-1', externalId: '77001' },
  actionsEnabled: true,
};

describe('ActionCapabilityRegistryService', () => {
  const registry = new ActionCapabilityRegistryService([
    gatewayFor('META', [
      capability({ type: 'PAUSE_AD' }),
      capability({ type: 'ADJUST_AD_SET_BUDGET', validationDepth: 'PLATFORM' }),
      capability({ type: 'PAUSE_CAMPAIGN' }),
      capability({
        type: 'ARCHIVE_AD',
        supported: false,
        reversible: false,
        unsupportedReason: 'Entra na segunda metade do sprint.',
      }),
    ]),
  ]);

  it('resolve o nível de cada ação sem consultar plataforma', () => {
    expect(registry.levelOf('PAUSE_AD')).toBe('AD');
    expect(registry.levelOf('ADJUST_AD_SET_BUDGET')).toBe('AD_SET');
    expect(registry.levelOf('ADJUST_CAMPAIGN_BUDGET')).toBe('CAMPAIGN');
  });

  /**
   * Os dois ids não são intercambiáveis, e trocá-los é um bug caro: I2 excluiria
   * por um id que a plataforma não conhece, e o gateway escreveria num id que o
   * banco não reconhece.
   */
  it('separa o id do domínio do id da plataforma', () => {
    expect(registry.targetIdFor('AD_SET', target)).toBe('set-1');
    expect(registry.externalTargetIdFor('AD_SET', target)).toBe('99881');
    expect(registry.targetIdFor('CAMPAIGN', target)).toBe('camp-1');
    expect(registry.externalTargetIdFor('CAMPAIGN', target)).toBe('77001');
  });

  it('anexa a permissão exigida em cada ação (§13.5)', () => {
    const actions = registry.resolveFor({
      target,
      inFlight: [],
      permissionFor,
    });

    expect(actions.find((a) => a.type === 'PAUSE_AD')?.requiredPermission).toBe(
      'actions:execute',
    );
    expect(
      actions.find((a) => a.type === 'ADJUST_AD_SET_BUDGET')
        ?.requiredPermission,
    ).toBe('actions:execute_sensitive');
  });

  it('marca indisponível a ação com escrita em voo no mesmo alvo', () => {
    const actions = registry.resolveFor({
      target,
      inFlight: [
        {
          executionId: 'exec-9',
          targetEntityType: 'AD_SET',
          targetEntityId: 'set-1',
        },
      ],
      permissionFor,
    });

    expect(
      actions.find((a) => a.type === 'ADJUST_AD_SET_BUDGET'),
    ).toMatchObject({ available: false, reason: 'WRITE_IN_FLIGHT' });
    // I2 é por alvo, não por anúncio: a ação no anúncio segue disponível.
    expect(actions.find((a) => a.type === 'PAUSE_AD')?.available).toBe(true);
  });

  it('acompanha ação de campanha com aviso de escopo', () => {
    const actions = registry.resolveFor({
      target,
      inFlight: [],
      permissionFor,
    });

    expect(
      actions.find((a) => a.type === 'PAUSE_CAMPAIGN')?.scopeWarning,
    ).toContain('campanha inteira');
  });

  /**
   * Sem conjunto — a hierarquia do Google Search não tem o nível intermediário
   * — a ação não tem alvo. Não é a plataforma que recusa: é o anúncio que não
   * tem sobre o que agir, e o motivo declarado precisa dizer isso em vez de
   * mentir "não suportado".
   */
  it('declara ausência de alvo quando o anúncio não tem conjunto', () => {
    const actions = registry.resolveFor({
      target: { ...target, adSet: null },
      inFlight: [],
      permissionFor,
    });

    const budget = actions.find((a) => a.type === 'ADJUST_AD_SET_BUDGET');

    expect(budget?.available).toBe(false);
    expect(budget?.detail).toContain('Conjunto de anúncios');
  });

  it('propaga o motivo do gateway para a ação não suportada', () => {
    const actions = registry.resolveFor({
      target,
      inFlight: [],
      permissionFor,
    });

    expect(actions.find((a) => a.type === 'ARCHIVE_AD')).toMatchObject({
      available: false,
      reason: 'UNSUPPORTED_BY_PLATFORM',
      detail: 'Entra na segunda metade do sprint.',
    });
  });

  /**
   * Google e TikTok até A2-S8. A mesma tela precisa servir as três plataformas
   * sem saber quais já escrevem — e treze ações declaradas indisponíveis é uma
   * resposta que a tela sabe renderizar; uma lista vazia não é.
   */
  it('declara as treze ações quando a plataforma ainda não escreve', () => {
    const actions = registry.resolveFor({
      target: { ...target, platform: 'GOOGLE' },
      inFlight: [],
      permissionFor,
    });

    expect(actions).toHaveLength(13);
    expect(actions.every((a) => !a.available)).toBe(true);
    expect(actions[0].detail).toContain('GOOGLE');
  });

  /**
   * §13.3 / entrega 5 de S8 — o usuário precisa saber, **antes** de confirmar,
   * que a mudança reinicia o aprendizado e zera a prova social. Enquanto isso
   * viajava dentro de `requiresRecreate`, a tela tinha de escolher entre avisar
   * de menos e mentir sobre o id do anúncio.
   */
  it('acompanha cada ação do impacto que ela causa na entrega', () => {
    const actions = registry.resolveFor({
      target,
      inFlight: [],
      permissionFor,
    });

    expect(actions.find((a) => a.type === 'PAUSE_AD')?.impact).toEqual({
      resetsLearning: false,
      losesSocialProof: false,
      changesResourceId: false,
    });
  });

  it('declara impacto mesmo onde a plataforma não recria (Meta, criativo)', () => {
    const actions = new ActionCapabilityRegistryService([
      gatewayFor('META', [capability({ type: 'REPLACE_CREATIVE' })]),
    ]).resolveFor({ target, inFlight: [], permissionFor });

    expect(actions.find((a) => a.type === 'REPLACE_CREATIVE')).toMatchObject({
      requiresRecreate: false,
      impact: {
        resetsLearning: true,
        losesSocialProof: true,
        changesResourceId: false,
      },
    });
  });

  it('não expõe gateway para plataforma que não registrou nenhum', () => {
    expect(registry.gatewayFor('GOOGLE')).toBeNull();
    expect(registry.supportedPlatforms()).toEqual(['META']);
  });
});

describe('grupo de recursos do Performance Max na tela de ações (D23)', () => {
  // O gateway real: é a declaração dele que decide o que a tela oferece.
  const registry = new ActionCapabilityRegistryService([
    new GoogleAdActionGateway({} as never, { get: () => 'v24' } as never),
  ]);

  const assetGroup: ActionTargetView = {
    ...target,
    platform: 'GOOGLE',
    externalAdId: 'asset_group:8800',
    unitKind: 'ASSET_GROUP',
    creativeFormat: 'PERFORMANCE_MAX',
    adSet: null,
    campaign: { id: 'camp-pmax', externalId: '6600' },
  };

  const actions = registry.resolveFor({
    target: assetGroup,
    inFlight: [],
    permissionFor,
  });
  const byType = (type: string) => actions.find((a) => a.type === type)!;

  it('oferece pausar o grupo', () => {
    expect(byType('PAUSE_AD').available).toBe(true);
  });

  it('recusa com motivo o que não vale para grupo de recursos', () => {
    for (const type of ['ARCHIVE_AD', 'REPLACE_COPY', 'DUPLICATE_AD']) {
      expect(byType(type)).toMatchObject({
        available: false,
        reason: 'UNSUPPORTED_BY_PLATFORM',
        detail: 'Esta ação ainda não está disponível para grupo de recursos.',
      });
    }
  });

  it('ação de conjunto não tem alvo: o grupo pende direto da campanha', () => {
    expect(byType('PAUSE_AD_SET').available).toBe(false);
  });

  it('ação de campanha continua valendo, com aviso de escopo', () => {
    expect(byType('PAUSE_CAMPAIGN')).toMatchObject({
      available: true,
      scopeWarning: expect.any(String),
    });
  });
});

describe('anúncio Smart+ do TikTok na tela de ações (D24)', () => {
  // O gateway real do TikTok não declara o pacote em ação nenhuma: campanha,
  // grupo e anúncio Smart+ têm rotas próprias, ainda não validadas.
  const registry = new ActionCapabilityRegistryService([
    new TikTokAdActionGateway({} as never),
  ]);

  const smartPlus: ActionTargetView = {
    ...target,
    platform: 'TIKTOK',
    externalAdId: 's1',
    unitKind: 'ASSET_GROUP',
    creativeFormat: 'SMART_PLUS',
    adSet: { id: 'sg-uuid', externalId: 'sg1' },
    campaign: { id: 'sc-uuid', externalId: 'sc1' },
  };

  it('nenhuma ação é oferecida, em nível nenhum, e o motivo usa o nome do TikTok', () => {
    const actions = registry.resolveFor({
      target: smartPlus,
      inFlight: [],
      permissionFor,
    });
    expect(actions.some((a) => a.available)).toBe(false);
    for (const type of ['PAUSE_AD', 'PAUSE_AD_SET', 'PAUSE_CAMPAIGN']) {
      expect(actions.find((a) => a.type === type)).toMatchObject({
        available: false,
        detail: 'Esta ação ainda não está disponível para anúncio Smart+.',
      });
    }
  });
});
