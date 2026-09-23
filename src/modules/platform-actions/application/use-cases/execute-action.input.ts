import type { CreateAdActionDto } from 'src/modules/platform-actions/application/dtos/create-ad-action.dto';
import type { AdActionOrigin } from 'src/shared/domain/events/domain-event-map';

/**
 * A entrada do **caminho de escrita único** (§13.5, P5).
 *
 * Mora em arquivo próprio porque três consumidores a montam — o `POST` direto,
 * o lote de A2-S8 e a aplicação de recomendação de A2-S9 —, e porque o use case
 * tem teto de ~150 linhas (§16.6). Contrato num arquivo, decisão em outro.
 */
export type ExecuteActionInput = {
  organizationId: string;
  accountId: string;
  adId: string;
  body: CreateAdActionDto;
  idempotencyKey: string;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * De onde a intenção veio (P3). Omitido, é `USER_DIRECT`.
   *
   * Aplicar uma recomendação entra **pelo mesmo use case**, e não por um
   * caminho próprio: a cadeia de P5 — kill switch, consentimento, capability,
   * I2, revalidação, auditoria — está inteira lá, e um segundo caminho de
   * escrita seria, por construção, o que não tem as guardas. É a mesma decisão
   * que o lote de A2-S8 tomou.
   */
  origin?: AdActionOrigin;
  recommendationId?: string | null;
  /** A `AdAction` já gravada pela geração; aplicar é executá-la (§9.5 passo 4). */
  existingActionId?: string | null;
};
