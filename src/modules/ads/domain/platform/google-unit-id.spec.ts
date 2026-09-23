import {
  googleAssetGroupExternalId,
  parseGoogleUnitExternalId,
  splitGoogleUnitIds,
} from './google-unit-id';

describe('id externo da unidade do Google', () => {
  it('o anúncio fica com o id cru; o grupo de recursos, prefixado', () => {
    expect(googleAssetGroupExternalId('456')).toBe('asset_group:456');
    expect(parseGoogleUnitExternalId('123')).toEqual({
      kind: 'AD',
      adId: '123',
    });
    expect(parseGoogleUnitExternalId('asset_group:456')).toEqual({
      kind: 'ASSET_GROUP',
      assetGroupId: '456',
    });
  });

  it('recusa o que não é id do Google — o valor vai para GAQL', () => {
    expect(parseGoogleUnitExternalId('abc')).toBeNull();
    expect(parseGoogleUnitExternalId('asset_group:')).toBeNull();
    expect(parseGoogleUnitExternalId('asset_group:1 OR 1=1')).toBeNull();
    expect(parseGoogleUnitExternalId('')).toBeNull();
  });

  it('separa o refresh dirigido por recurso, sem repetir', () => {
    expect(
      splitGoogleUnitIds(['1', 'asset_group:2', '1', 'x', 'asset_group:2']),
    ).toEqual({ adIds: ['1'], assetGroupIds: ['2'] });
  });
});
