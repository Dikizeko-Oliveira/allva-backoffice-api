import { googleDeliveryStatus, tiktokDeliveryStatus } from './delivery-status';

/**
 * O equivalente do `effective_status` da Meta. Sem ele, um anúncio ligado dentro
 * de campanha pausada aparecia como ativo no Google e no TikTok — e o mesmo
 * detector, a mesma escada de verificação e a mesma reconciliação davam
 * respostas diferentes da Meta para a mesma situação.
 */
describe('googleDeliveryStatus', () => {
  it('pausa herdada da campanha vence o ENABLED do anúncio', () => {
    expect(
      googleDeliveryStatus({
        adStatus: 'ENABLED',
        adGroupStatus: 'ENABLED',
        campaignStatus: 'PAUSED',
      }),
    ).toBe('PAUSED');
  });

  it('remoção em qualquer nível vence a pausa', () => {
    expect(
      googleDeliveryStatus({
        adStatus: 'PAUSED',
        adGroupStatus: 'REMOVED',
        campaignStatus: 'ENABLED',
      }),
    ).toBe('REMOVED');
  });

  it('anúncio reprovado aparece como DISAPPROVED', () => {
    expect(
      googleDeliveryStatus({
        adStatus: 'ENABLED',
        adGroupStatus: 'ENABLED',
        campaignStatus: 'ENABLED',
        approvalStatus: 'DISAPPROVED',
      }),
    ).toBe('DISAPPROVED');
  });

  it('revisão em andamento aparece como PENDING_REVIEW', () => {
    expect(
      googleDeliveryStatus({
        adStatus: 'ENABLED',
        reviewStatus: 'REVIEW_IN_PROGRESS',
      }),
    ).toBe('PENDING_REVIEW');
  });

  it('ligado nos três níveis e aprovado continua ENABLED', () => {
    expect(
      googleDeliveryStatus({
        adStatus: 'ENABLED',
        adGroupStatus: 'ENABLED',
        campaignStatus: 'ENABLED',
        approvalStatus: 'APPROVED',
        reviewStatus: 'REVIEWED',
      }),
    ).toBe('ENABLED');
  });

  it('sem o status do próprio recurso não inventa um', () => {
    expect(googleDeliveryStatus({ campaignStatus: 'PAUSED' })).toBeNull();
  });
});

describe('tiktokDeliveryStatus', () => {
  it('prefere o status de entrega à chave liga/desliga', () => {
    expect(
      tiktokDeliveryStatus({
        operationStatus: 'ENABLE',
        secondaryStatus: 'AD_STATUS_CAMPAIGN_DISABLE',
      }),
    ).toBe('AD_STATUS_CAMPAIGN_DISABLE');
  });

  it('cai para operation_status quando não há status de entrega', () => {
    expect(tiktokDeliveryStatus({ operationStatus: 'DISABLE' })).toBe(
      'DISABLE',
    );
  });

  it('sem nenhum dos dois devolve null', () => {
    expect(tiktokDeliveryStatus({})).toBeNull();
  });
});
