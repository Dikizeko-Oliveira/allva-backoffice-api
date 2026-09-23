import { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import { Permission } from 'src/modules/organizations/domain/rbac';

/**
 * §13.5 — que permissão cada tipo de ação exige.
 *
 * O mapa é `Record<AdActionType, Permission>` **total de propósito**: um tipo de
 * ação novo não compila até alguém decidir quem pode executá-lo. A alternativa —
 * `Partial` com um default — faria a ação nova nascer com a permissão mais
 * frouxa do mapa, e o esquecimento seria invisível até alguém exercê-lo em
 * produção.
 *
 * **A fronteira é blast radius, não nível de entidade.** `PAUSE_CAMPAIGN` para
 * dinheiro e `ADJUST_CAMPAIGN_BUDGET` o move: a primeira é reversível com um
 * clique e a segunda muda quanto a organização gasta amanhã. É por isso que
 * pausar/reativar vive em `actions:execute` e orçamento, arquivamento e troca de
 * conteúdo vivem em `actions:execute_sensitive` — a escala de estrago difere,
 * não a profundidade da árvore.
 */
export const ACTION_TYPE_PERMISSION: Record<AdActionType, Permission> = {
  PAUSE_AD: 'actions:execute',
  ENABLE_AD: 'actions:execute',
  PAUSE_AD_SET: 'actions:execute',
  ENABLE_AD_SET: 'actions:execute',
  PAUSE_CAMPAIGN: 'actions:execute',
  ENABLE_CAMPAIGN: 'actions:execute',

  /** Irreversível na Meta e `REMOVED` no Google — não há caminho de volta. */
  ARCHIVE_AD: 'actions:execute_sensitive',
  /** Cria entidade que passa a gastar (P1 — derivação declarada). */
  DUPLICATE_AD: 'actions:execute_sensitive',
  /** Recriam o anúncio em alguma plataforma: reiniciam aprendizado e zeram prova social. */
  REPLACE_CREATIVE: 'actions:execute_sensitive',
  REPLACE_COPY: 'actions:execute_sensitive',
  REPLACE_CTA: 'actions:execute_sensitive',
  /** Movem dinheiro diretamente. */
  ADJUST_AD_SET_BUDGET: 'actions:execute_sensitive',
  ADJUST_CAMPAIGN_BUDGET: 'actions:execute_sensitive',
};

export function permissionFor(type: AdActionType): Permission {
  return ACTION_TYPE_PERMISSION[type];
}
