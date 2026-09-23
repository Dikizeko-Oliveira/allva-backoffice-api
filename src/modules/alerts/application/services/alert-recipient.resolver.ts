import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

export type AlertRecipient = {
  accountId: string;
  email: string;
  name: string;
};

/**
 * Resolve quem recebe o e-mail do alerta.
 *
 * Desde A2-S1 o alerta pertence a uma **organização** (`organizationId` NOT
 * NULL), não a uma conta: o destinatário passa a ser a conta dona dela. O
 * fan-out para todo ADMIN da organização é de A2-S3, quando `alerts` vira
 * consumidor de evento puro — este resolver existe justamente para que essa
 * mudança não toque a lógica de entrega.
 */
@Injectable()
export class AlertRecipientResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(organizationId: string): Promise<AlertRecipient | null> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { owner: { select: { id: true, email: true, name: true } } },
    });

    const owner = organization?.owner;
    if (!owner?.email) return null;

    return { accountId: owner.id, email: owner.email, name: owner.name };
  }
}
