import { Injectable, Logger } from '@nestjs/common';
import { VideoProcessingPortInterface } from 'src/modules/creative-lab/domain/ports/video-processing.port';
import { CreativeThumbnailRepositoryInterface } from 'src/modules/creative-lab/domain/ports/creative-thumbnail.repository';
import { StoragePortInterface } from 'src/shared/application/ports/storage.port';
import { Inject } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

export type ThumbnailOutcome = {
  requested: number;
  generated: number;
  /** Falharam na extração — o criativo continua utilizável, só sem miniatura. */
  failed: number;
  skippedDisabled: boolean;
};

/**
 * ffmpeg religado (D7) — miniatura de criativo **sincronizado**.
 *
 * O pipeline veio de `campaigns/`, que A2-S1 removeu, e ficou parqueado
 * esperando um consumidor real. Este é ele: um criativo de vídeo que a
 * plataforma entregou **sem `thumbnailUrl`** não tem como ser mostrado na tela,
 * e a Allva já tem o vídeo.
 *
 * **Isto não é originar mídia (P1).** O frame é extraído de um vídeo que já está
 * veiculando na conta do usuário; nada é criado, nada é publicado. A distinção
 * importa: gerar criativo seria violar o princípio, e derivar uma imagem do que
 * já existe é o que P1 chama explicitamente de "no máximo, deriva".
 */
@Injectable()
export class CreativeThumbnailService {
  private readonly logger = new Logger(CreativeThumbnailService.name);

  constructor(
    private readonly video: VideoProcessingPortInterface,
    private readonly creatives: CreativeThumbnailRepositoryInterface,
    @Inject(StoragePortInterface)
    private readonly storage: StoragePortInterface,
    private readonly env: EnvService,
  ) {}

  async backfill(input: {
    organizationId: string;
    limit?: number;
  }): Promise<ThumbnailOutcome> {
    if (!this.env.get('VIDEO_PREVIEW_ENABLED')) {
      // Um binário de ffmpeg indisponível na imagem não pode derrubar nada: a
      // miniatura é conforto, e a flag é o interruptor que o time opera sem
      // deploy.
      return {
        requested: 0,
        generated: 0,
        failed: 0,
        skippedDisabled: true,
      };
    }

    const pending = await this.creatives.listMissingThumbnail({
      organizationId: input.organizationId,
      limit: input.limit ?? 50,
    });

    const outcome: ThumbnailOutcome = {
      requested: pending.length,
      generated: 0,
      failed: 0,
      skippedDisabled: false,
    };

    for (const creative of pending) {
      try {
        const frame = await this.video.extractFirstFrame(creative.videoUrl);
        const uploaded = await this.storage.upload(
          frame.buffer,
          `creative-${creative.creativeId}.${frame.extension}`,
          frame.mimeType,
          'creative-thumbnails',
        );

        await this.creatives.setThumbnail(creative.creativeId, uploaded.url);
        outcome.generated += 1;
      } catch (error) {
        // Falha de extração **nunca** interrompe o lote nem marca o criativo
        // como quebrado: um vídeo com codec exótico é um criativo sem miniatura,
        // não um criativo inválido.
        outcome.failed += 1;
        this.logger.warn(
          `creative.thumbnail_failed creativeId=${creative.creativeId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (outcome.generated > 0) {
      this.logger.log(
        `creative.thumbnails organizationId=${input.organizationId} ` +
          `geradas=${outcome.generated} falhas=${outcome.failed}`,
      );
    }

    return outcome;
  }
}
