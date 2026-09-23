import { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import { roleHasPermission } from 'src/modules/organizations/domain/rbac';
import { ACTION_TYPE_PERMISSION, permissionFor } from './action-permissions';

const ALL_ACTION_TYPES = Object.keys(ACTION_TYPE_PERMISSION) as AdActionType[];

describe('§13.5 — permissão por tipo de ação', () => {
  it('exige o nível sensível para arquivar, orçamento, duplicar e trocar conteúdo', () => {
    const sensitive = ALL_ACTION_TYPES.filter(
      (type) => permissionFor(type) === 'actions:execute_sensitive',
    );

    expect(sensitive.sort()).toEqual(
      [
        'ADJUST_AD_SET_BUDGET',
        'ADJUST_CAMPAIGN_BUDGET',
        'ARCHIVE_AD',
        'DUPLICATE_AD',
        'REPLACE_CREATIVE',
        'REPLACE_COPY',
        'REPLACE_CTA',
      ].sort(),
    );
  });

  it('deixa pausar e reativar no nível ordinário, em qualquer entidade', () => {
    const ordinary = ALL_ACTION_TYPES.filter(
      (type) => permissionFor(type) === 'actions:execute',
    );

    expect(ordinary.sort()).toEqual(
      [
        'ENABLE_AD',
        'ENABLE_AD_SET',
        'ENABLE_CAMPAIGN',
        'PAUSE_AD',
        'PAUSE_AD_SET',
        'PAUSE_CAMPAIGN',
      ].sort(),
    );
  });

  /**
   * O mapa nunca devolve `undefined`: se devolvesse, o chamador compararia
   * `undefined` contra a lista de permissões do papel, e o resultado seria uma
   * ação executada sem autorização nenhuma — falha aberta, não fechada.
   */
  it('resolve permissão para todo tipo de ação, sem buraco', () => {
    for (const type of ALL_ACTION_TYPES) {
      expect(permissionFor(type)).toBeDefined();
    }

    expect(ALL_ACTION_TYPES).toHaveLength(13);
  });

  /**
   * A ponta que fecha o ciclo com a matriz: não basta o mapa classificar
   * `ADJUST_CAMPAIGN_BUDGET` como sensível — o papel que o plano diz que não
   * pode movê-lo precisa, de fato, não poder.
   */
  it('impede ANALYST de mover orçamento e FINANCE de tocar em qualquer ação', () => {
    expect(
      roleHasPermission('ANALYST', permissionFor('ADJUST_CAMPAIGN_BUDGET')),
    ).toBe(false);
    expect(roleHasPermission('ANALYST', permissionFor('PAUSE_AD'))).toBe(true);

    for (const type of ALL_ACTION_TYPES) {
      expect(roleHasPermission('FINANCE', permissionFor(type))).toBe(false);
    }
  });
});
