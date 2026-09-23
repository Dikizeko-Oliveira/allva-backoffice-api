import { Injectable } from '@nestjs/common';
import type { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import {
  WriteConsentRepositoryInterface,
  WriteConsentView,
} from 'src/modules/platform-actions/domain/ports/write-consent.repository';
import type { ConsentState } from 'src/modules/platform-actions/domain/write-guards';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

type ConsentRow = {
  id: string;
  integrationId: string;
  organizationId: string;
  grantedByAccountId: string;
  grantedAt: Date;
  revokedAt: Date | null;
  revokedByAccountId: string | null;
  consentedActionTypes: string[];
};

@Injectable()
export class WriteConsentPrismaRepository extends WriteConsentRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async stateFor(input: {
    organizationId: string;
    integrationId: string;
  }): Promise<ConsentState> {
    /**
     * O mais recente, ativo ou não — e a ordem importa.
     *
     * Filtrar por `revokedAt: null` devolveria "nunca consentiu" para uma
     * integração que consentiu e revogou. As duas frases pedem telas diferentes:
     * a primeira convida a conceder, a segunda diz que alguém tirou a
     * autorização de propósito.
     */
    const row = await this.prisma.integrationWriteConsent.findFirst({
      where: {
        organizationId: input.organizationId,
        integrationId: input.integrationId,
      },
      orderBy: { grantedAt: 'desc' },
      select: {
        revokedAt: true,
        consentedActionTypes: true,
      },
    });

    if (!row) return { status: 'ABSENT' };
    if (row.revokedAt) return { status: 'REVOKED', revokedAt: row.revokedAt };

    return {
      status: 'GRANTED',
      consentedActionTypes: row.consentedActionTypes as AdActionType[],
    };
  }

  async grant(input: {
    organizationId: string;
    integrationId: string;
    grantedByAccountId: string;
    consentedActionTypes: AdActionType[];
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<WriteConsentView> {
    return this.prisma.$transaction(async (tx) => {
      /**
       * Revoga o anterior **no mesmo ato**. Sem isso, ampliar os tipos deixaria
       * duas linhas vivas para a mesma integração, e a leitura teria de
       * desempatar — qualquer critério seria arbitrário, e o errado autorizaria
       * mais do que o usuário concedeu por último.
       */
      await tx.integrationWriteConsent.updateMany({
        where: {
          organizationId: input.organizationId,
          integrationId: input.integrationId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revokedByAccountId: input.grantedByAccountId,
        },
      });

      const row = await tx.integrationWriteConsent.create({
        data: {
          integrationId: input.integrationId,
          organizationId: input.organizationId,
          grantedByAccountId: input.grantedByAccountId,
          consentedActionTypes: input.consentedActionTypes,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        },
      });

      return toView(row);
    });
  }

  async revoke(input: {
    organizationId: string;
    integrationId: string;
    revokedByAccountId: string;
  }): Promise<WriteConsentView | null> {
    const active = await this.prisma.integrationWriteConsent.findFirst({
      where: {
        organizationId: input.organizationId,
        integrationId: input.integrationId,
        revokedAt: null,
      },
      orderBy: { grantedAt: 'desc' },
      select: { id: true },
    });

    if (!active) return null;

    // Soft: a trilha de quem autorizou o quê, e até quando, não se apaga.
    const row = await this.prisma.integrationWriteConsent.update({
      where: { id: active.id },
      data: {
        revokedAt: new Date(),
        revokedByAccountId: input.revokedByAccountId,
      },
    });

    return toView(row);
  }

  async listFor(input: {
    organizationId: string;
  }): Promise<WriteConsentView[]> {
    const rows = await this.prisma.integrationWriteConsent.findMany({
      where: { organizationId: input.organizationId },
      orderBy: { grantedAt: 'desc' },
    });

    return rows.map(toView);
  }
}

function toView(row: ConsentRow): WriteConsentView {
  return {
    id: row.id,
    integrationId: row.integrationId,
    organizationId: row.organizationId,
    grantedByAccountId: row.grantedByAccountId,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    revokedByAccountId: row.revokedByAccountId,
    consentedActionTypes: row.consentedActionTypes as AdActionType[],
  };
}
