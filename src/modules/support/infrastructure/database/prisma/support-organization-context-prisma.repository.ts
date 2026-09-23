import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  SupportOrganizationContext,
  SupportOrganizationContextPortInterface,
} from 'src/modules/support/domain/ports';

@Injectable()
export class SupportOrganizationContextPrismaRepository implements SupportOrganizationContextPortInterface {
  constructor(private readonly prisma: PrismaService) {}

  async resolveMany(
    organizationIds: readonly string[],
  ): Promise<Map<string, SupportOrganizationContext>> {
    // Uma página sem chamados não deve custar uma consulta com `IN ()`.
    if (organizationIds.length === 0) return new Map();

    const rows = await this.prisma.organization.findMany({
      where: { id: { in: [...new Set(organizationIds)] } },
      select: {
        id: true,
        name: true,
        subscription: { select: { plan: { select: { type: true } } } },
      },
    });

    return new Map(
      rows.map((row) => [
        row.id,
        {
          name: row.name,
          planType: row.subscription?.plan?.type ?? null,
        },
      ]),
    );
  }
}
