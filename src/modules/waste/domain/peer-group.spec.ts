import { peerScopeOf } from './benchmark';
import { aggregate } from './test-support/aggregate.fixture';
import { peersOf } from './window-aggregate';
import { peerGroupKeyOf } from 'src/modules/ads/domain/ad-unit';
import type { AdWindowAggregate } from './detection-context';

/**
 * **Com quem a unidade se compara** (D23).
 *
 * O anúncio compara-se com os do mesmo conjunto. O grupo de recursos do
 * Performance Max não tem conjunto: sem regra própria, ficava sem par nenhum e
 * todo detector relativo recusava. Os grupos da mesma campanha disputam o mesmo
 * orçamento — são eles os pares.
 */

const byPeerGroup = (units: AdWindowAggregate[]) => {
  const groups = new Map<string, AdWindowAggregate[]>();
  for (const unit of units) {
    const key = peerGroupKeyOf(unit);
    groups.set(key, [...(groups.get(key) ?? []), unit]);
  }
  return groups;
};

const assetGroup = (adId: string, campaignId = 'campaign-pmax') =>
  aggregate({
    adId,
    adSetId: null,
    campaignId,
    platform: 'GOOGLE',
    unitKind: 'ASSET_GROUP',
  });

describe('pares da unidade', () => {
  it('anúncio: os do mesmo conjunto, sem ele mesmo', () => {
    const units = [
      aggregate({ adId: 'a1', adSetId: 's1' }),
      aggregate({ adId: 'a2', adSetId: 's1' }),
      aggregate({ adId: 'a3', adSetId: 's2' }),
    ];

    expect(peersOf(units[0], byPeerGroup(units)).map((p) => p.adId)).toEqual([
      'a2',
    ]);
  });

  it('grupo de recursos: os da mesma campanha', () => {
    const units = [
      assetGroup('g1'),
      assetGroup('g2'),
      assetGroup('g3'),
      assetGroup('g4', 'campaign-other'),
    ];

    expect(peersOf(units[0], byPeerGroup(units)).map((p) => p.adId)).toEqual([
      'g2',
      'g3',
    ]);
  });

  it('a campanha não se confunde com um conjunto de mesmo id', () => {
    // Os dois são UUIDs do domínio; o prefixo impede que um grupo de recursos
    // vire par de anúncios só porque os ids coincidiram.
    const units = [
      assetGroup('g1', 'x'),
      aggregate({ adId: 'a1', adSetId: 'x', campaignId: 'c' }),
    ];

    expect(peersOf(units[0], byPeerGroup(units))).toEqual([]);
  });

  it('pausado e sem dia observado não entram como par', () => {
    const units = [
      assetGroup('g1'),
      { ...assetGroup('g2'), isDelivering: false },
      { ...assetGroup('g3'), days: 0 },
    ];

    expect(peersOf(units[0], byPeerGroup(units))).toEqual([]);
  });

  it('o diagnóstico diz onde a comparação aconteceu', () => {
    expect(peerScopeOf({ adSetId: 's1' }).of).toBe('do conjunto');
    expect(peerScopeOf({ adSetId: null }).of).toBe('da campanha');
    expect(peerScopeOf({ adSetId: null }).same).toBe('na mesma campanha');
  });
});
