import type { RecommendationKind } from '../contracts/recommendation-catalog';
import type { ActiveSuppression, SuppressionScope } from '../suppression';

export type SuppressionView = ActiveSuppression & {
  createdByAccountId: string;
  createdAt: Date;
};

export abstract class SuppressionsRepositoryInterface {
  abstract list(organizationId: string): Promise<SuppressionView[]>;

  abstract create(input: {
    organizationId: string;
    kind: RecommendationKind;
    scope: SuppressionScope;
    scopeId: string | null;
    reason: string;
    createdByAccountId: string;
    expiresAt: Date | null;
  }): Promise<SuppressionView>;

  abstract remove(id: string, organizationId: string): Promise<boolean>;

  /**
   * Remove as vencidas (C5).
   *
   * A leitura já ignora supressão expirada — o job existe para a tabela não
   * crescer sem fim, não para a correção. Depender dele para o comportamento
   * faria uma supressão de 7 dias silenciar por 8 no dia em que o cron atrasa.
   */
  abstract purgeExpired(now: Date): Promise<number>;
}
