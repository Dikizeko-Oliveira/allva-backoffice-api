import { Prisma } from 'generated/prisma/client';
import { SYNCABLE_INTEGRATION_STATUSES } from 'src/modules/integrations/domain/entities/integration.entity';

/**
 * A conta de anúncios **vinculada a uma credencial que ainda se lê**, numa
 * organização que existe.
 *
 * É a metade "conta" da pergunta "os jobs podem varrer isto?" — a outra metade,
 * acesso da organização, é de `OrganizationSweepPolicyService`. Mora num lugar
 * só porque cada repositório de alvo escrevia a sua, e nenhuma olhava o status
 * da integração: credencial com token vencido seguia com ingest de hora em hora,
 * tentando renovar o token a cada tick.
 *
 * Sem o congelamento de propósito: quem conta anúncios fora do teto precisa
 * continuar contando os de conta congelada, que estão fora **por plano**.
 */
export function linkedAdAccountWhere(): Prisma.AdAccountWhereInput {
  return {
    integrationId: { not: null },
    integration: {
      is: { status: { in: [...SYNCABLE_INTEGRATION_STATUSES] } },
    },
    organization: { is: { deletedAt: null } },
  };
}

/**
 * Vinculada, e não congelada **agora**. `frozenAt` no futuro é agendamento — o
 * cliente pagou o período — e não corta nada.
 */
export function sweepableAdAccountWhere(now: Date): Prisma.AdAccountWhereInput {
  return {
    AND: [
      linkedAdAccountWhere(),
      { OR: [{ frozenAt: null }, { frozenAt: { gt: now } }] },
    ],
  };
}

/**
 * `sweepableAdAccountWhere` em SQL, para as consultas cruas que juntam
 * `"ad_accounts" acc`. A organização fica de fora: essas consultas já são por
 * organização, e quem as chama já passou pela política de acesso.
 */
export const SWEEPABLE_AD_ACCOUNT_SQL = Prisma.sql`
  acc."integration_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "integrations" i
    WHERE i."id" = acc."integration_id"
      AND i."status"::text IN (${Prisma.join([...SYNCABLE_INTEGRATION_STATUSES])})
  )
  AND (acc."frozen_at" IS NULL OR acc."frozen_at" > NOW())
`;
