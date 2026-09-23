import {
  conversionTarget,
  nonConversionTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';
import { benchmarkKeyOf, isAdUnitKind, peerGroupKeyOf } from './ad-unit';

describe('unidade analisada', () => {
  it('o anúncio mantém a chave de comparação de sempre', () => {
    // Nenhuma régua existente muda: a separação só acrescenta segmentos.
    expect(
      benchmarkKeyOf({
        unitKind: 'AD',
        optimization: conversionTarget('PURCHASE'),
      }),
    ).toBe('CONVERSION:PURCHASE');
  });

  it('o grupo de recursos tem régua própria, com o mesmo objetivo e evento', () => {
    expect(
      benchmarkKeyOf({
        unitKind: 'ASSET_GROUP',
        optimization: conversionTarget('PURCHASE'),
      }),
    ).toBe('ASSET_GROUP|CONVERSION:PURCHASE');
    expect(
      benchmarkKeyOf({
        unitKind: 'ASSET_GROUP',
        optimization: nonConversionTarget('AWARENESS'),
      }),
    ).toBe('ASSET_GROUP|AWARENESS');
  });

  it('pares: o conjunto, e a campanha quando não há conjunto', () => {
    expect(peerGroupKeyOf({ adSetId: 's1', campaignId: 'c1' })).toBe('s1');
    expect(peerGroupKeyOf({ adSetId: null, campaignId: 'c1' })).toBe(
      'campaign:c1',
    );
  });

  it('reconhece só os tipos declarados', () => {
    expect(isAdUnitKind('ASSET_GROUP')).toBe(true);
    expect(isAdUnitKind('asset_group')).toBe(false);
    expect(isAdUnitKind(null)).toBe(false);
  });
});
