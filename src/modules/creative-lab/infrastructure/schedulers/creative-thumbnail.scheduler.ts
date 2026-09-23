import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import { CreativeThumbnailRepositoryInterface } from 'src/modules/creative-lab/domain/ports/creative-thumbnail.repository';
import { CreativeThumbnailService } from 'src/modules/creative-lab/application/services/creative-thumbnail.service';

/** Quantas organizações o ciclo diário tenta — não quantos criativos: cada uma
 * já limita a própria leitura em `CreativeThumbnailService.backfill`. */
const ORGANIZATIONS_PER_CYCLE = 200;

/**
 * O gatilho que faltava para `CreativeThumbnailService.backfill` (D7).
 *
 * O serviço e o extrator de ffmpeg existiam desde A2-S4/S9, prontos e
 * testados, sem nenhum chamador — nenhum controller, fila ou cron. Um
 * criativo de vídeo que a plataforma entrega sem `thumbnailUrl` (Google
 * sempre; TikTok e Meta quando a resolução falha) ficava sem miniatura para
 * sempre, porque nada nunca invocava o único código que resolvia isso.
 *
 * **Não depende do sync do dia.** Ao contrário de `AdScoringScheduler`, que
 * só faz sentido depois da varredura completa, aqui não há uma dependência a
 * esperar: a consulta é "quem está sem miniatura agora", e roda sobre o que
 * já foi sincronizado — de hoje ou de qualquer dia anterior. O horário
 * (04h30) só evita concorrer com a varredura completa (03h20) pela mesma
 * conexão de banco; não há garantia nem necessidade de ordem.
 *
 * **Só organização com acesso aberto** (`FULL`), pela mesma razão de
 * `WasteScheduler`/`AdScoringScheduler`: gastar ffmpeg na conta de quem
 * perdeu acesso não tem para quem mostrar o resultado.
 */
@Injectable()
export class CreativeThumbnailScheduler {
  private readonly logger = new Logger(CreativeThumbnailScheduler.name);

  constructor(
    private readonly thumbnails: CreativeThumbnailRepositoryInterface,
    private readonly backfillService: CreativeThumbnailService,
    private readonly env: EnvService,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  @Cron('30 4 * * *', {
    name: 'creative-thumbnail-backfill',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async backfillDaily(): Promise<void> {
    if (!this.env.get('VIDEO_PREVIEW_ENABLED')) {
      this.logger.debug(
        'creative_thumbnail.disabled VIDEO_PREVIEW_ENABLED=false',
      );
      return;
    }

    const organizationIds =
      await this.thumbnails.listOrganizationsWithMissingThumbnail(
        ORGANIZATIONS_PER_CYCLE,
      );

    if (organizationIds.length === 0) return;

    const { kept, skipped } = await this.sweep.keepByMode(
      organizationIds.map((organizationId) => ({ organizationId })),
      (item) => item.organizationId,
      ['FULL'],
    );

    let generated = 0;
    let failed = 0;

    // Sequencial, e não `Promise.all`: cada organização já dispara vários
    // processos de ffmpeg (um por criativo, até o limite do backfill), e
    // paralelizar entre organizações multiplicaria isso sem limite algum.
    for (const { organizationId } of kept) {
      const outcome = await this.backfillService.backfill({ organizationId });
      generated += outcome.generated;
      failed += outcome.failed;
    }

    this.logger.log(
      `creative_thumbnail.backfill_enqueued organizacoes=${kept.length} ` +
        `fora_por_acesso=${skipped} geradas=${generated} falhas=${failed}`,
    );
  }
}
