/**
 * O status que o anúncio **de fato veicula**, composto a partir do que cada
 * plataforma expõe — o equivalente do `effective_status` da Meta para quem não
 * o entrega pronto.
 *
 * Um anúncio ligado dentro de uma campanha pausada não entrega. A Meta já
 * responde isso (`effective_status: CAMPAIGN_PAUSED`); o Google responde
 * `ENABLED` no anúncio e deixa a pausa no nível de cima, e o TikTok separa a
 * chave liga/desliga (`operation_status`) do estado de entrega
 * (`secondary_status`). Ler só o campo do anúncio fazia o mesmo detector, a
 * mesma escada de verificação e a mesma reconciliação chamarem de "ativo" no
 * Google e no TikTok o que na Meta aparecia como pausado.
 *
 * **Mora no domínio porque ingest e escrita precisam da mesma composição.** O
 * sync grava `observedStatus` com ela e a verificação compara o desejado com
 * ela; duas cópias divergiriam, e uma pausa confirmada pelo gateway seria lida
 * como drift pelo sync.
 *
 * O resultado é vocabulário **cru** da plataforma: quem traduz para o canônico é
 * `toCanonicalStatus`, pelo `PlatformProfile`.
 */

/**
 * Google Ads: remoção em qualquer nível vence, depois pausa em qualquer nível,
 * depois a política do anúncio. `DISAPPROVED` e `PENDING_REVIEW` não existem
 * como status do Google — são compostos aqui e mapeados no perfil.
 *
 * Também serve para grupo de anúncios: `adStatus` recebe o status do grupo e
 * `adGroupStatus` fica vazio.
 */
export function googleDeliveryStatus(input: {
  adStatus?: string | null;
  adGroupStatus?: string | null;
  campaignStatus?: string | null;
  approvalStatus?: string | null;
  reviewStatus?: string | null;
}): string | null {
  const own = input.adStatus ?? null;
  if (!own) return null;

  const levels = [own, input.adGroupStatus, input.campaignStatus];

  if (levels.includes('REMOVED')) return 'REMOVED';
  if (levels.includes('PAUSED')) return 'PAUSED';
  if (input.approvalStatus === 'DISAPPROVED') return 'DISAPPROVED';
  if (input.reviewStatus === 'REVIEW_IN_PROGRESS') return 'PENDING_REVIEW';

  return own;
}

/**
 * TikTok: `secondary_status` já herda a pausa do grupo e da campanha e carrega a
 * revisão; `operation_status` é só a chave do próprio objeto. Na falta do
 * primeiro, o segundo é a melhor leitura disponível — nunca um status inventado.
 */
export function tiktokDeliveryStatus(input: {
  operationStatus?: string | null;
  secondaryStatus?: string | null;
}): string | null {
  return input.secondaryStatus || input.operationStatus || null;
}
