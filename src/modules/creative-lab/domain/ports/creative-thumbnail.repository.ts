/**
 * Os criativos de vídeo que a plataforma entregou **sem miniatura** (D7).
 *
 * A consulta é estreita de propósito: só vídeo, só sem `thumbnailUrl`, só da
 * organização pedida. Um backfill que varre criativos que já têm miniatura
 * gastaria ffmpeg para reproduzir o que a plataforma já deu.
 */
export type CreativeMissingThumbnail = {
  creativeId: string;
  videoUrl: string;
};

export abstract class CreativeThumbnailRepositoryInterface {
  abstract listMissingThumbnail(input: {
    organizationId: string;
    limit: number;
  }): Promise<CreativeMissingThumbnail[]>;

  abstract setThumbnail(creativeId: string, url: string): Promise<void>;

  /**
   * Quais organizações têm ao menos um criativo de vídeo sem miniatura —
   * o alvo do backfill agendado, que não sabe de antemão quem precisa dele.
   *
   * `listMissingThumbnail` continua estreito por organização; esta consulta
   * é a única coisa nova que o agendamento precisa: por onde começar.
   */
  abstract listOrganizationsWithMissingThumbnail(
    limit: number,
  ): Promise<string[]>;
}
