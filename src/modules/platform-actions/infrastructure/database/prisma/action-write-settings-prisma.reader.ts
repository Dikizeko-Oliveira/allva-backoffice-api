import { Injectable } from '@nestjs/common';
import { ActionWriteSettingsReader } from 'src/modules/platform-actions/domain/ports/action-write-settings.reader';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class ActionWriteSettingsPrismaReader extends ActionWriteSettingsReader {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async actionDailyCap(organizationId: string): Promise<number | null> {
    const settings = await this.prisma.organizationAdsSettings.findUnique({
      where: { organizationId },
      select: { actionDailyCap: true },
    });

    // Organização sem linha de settings é organização sem teto configurado —
    // não uma organização com teto zero.
    return settings?.actionDailyCap ?? null;
  }

  async setActionsEnabled(input: {
    organizationId: string;
    enabled: boolean;
  }): Promise<void> {
    await this.prisma.organization.update({
      where: { id: input.organizationId },
      data: { actionsEnabled: input.enabled },
    });
  }

  async actionsEnabled(organizationId: string): Promise<boolean> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { actionsEnabled: true },
    });

    // Organização inexistente não escreve. O default seguro é o mesmo do kill
    // switch acionado — nunca presumir permissão a partir de ausência.
    return organization?.actionsEnabled ?? false;
  }
}
