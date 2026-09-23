/**
 * Extração de primeiro frame de vídeo.
 *
 * Veio de `campaigns/` (removido em A2-S1) e ficou aqui por D7: o pipeline serve
 * o domínio real — gerar thumbnail de criativo **sincronizado** que a plataforma
 * entregou sem `thumbnailUrl` —, não a campanha ficcional que o originou.
 *
 * **Parqueado até A2-S4**, atrás de `VIDEO_PREVIEW_ENABLED`. O worker do v1 foi
 * junto com `CreativeAsset`, a tabela que ele atualizava; o de S4 escreve em
 * `Creative`. O que se preserva aqui é o que tinha valor e teste: a extração.
 */
export type VideoPreviewFrame = {
  buffer: Buffer;
  mimeType: string;
  /** File extension without the dot, used to name the stored object. */
  extension: string;
};

export abstract class VideoProcessingPortInterface {
  /**
   * Decodes the first frame of a remote video into a still image. Implementations
   * must reject anything that is not an http(s) source.
   */
  abstract extractFirstFrame(videoUrl: string): Promise<VideoPreviewFrame>;
}
