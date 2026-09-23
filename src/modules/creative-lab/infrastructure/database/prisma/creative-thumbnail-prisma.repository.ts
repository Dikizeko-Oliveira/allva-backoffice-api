import { Injectable } from '@nestjs/common';
import {
  CreativeMissingThumbnail,
  CreativeThumbnailRepositoryInterface,
} from 'src/modules/creative-lab/domain/ports/creative-thumbnail.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class CreativeThumbnailPrismaRepository extends CreativeThumbnailRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listMissingThumbnail(input: {
    organizationId: string;
    limit: number;
  }): Promise<CreativeMissingThumbnail[]> {
    const rows = await this.prisma.creative.findMany({
      where: {
        organizationId: input.organizationId,
        thumbnailUrl: null,
        videoUrl: { not: null },
        // Criativo arquivado não veicula mais: gastar ffmpeg nele reproduz
        // uma miniatura que ninguém vai ver.
        archivedAt: null,
      },
      select: { id: true, videoUrl: true },
      take: input.limit,
    });

    return rows
      .filter((row): row is { id: string; videoUrl: string } =>
        Boolean(row.videoUrl),
      )
      .map((row) => ({ creativeId: row.id, videoUrl: row.videoUrl }));
  }

  async setThumbnail(creativeId: string, url: string): Promise<void> {
    await this.prisma.creative.update({
      where: { id: creativeId },
      data: { thumbnailUrl: url },
    });
  }

  async listOrganizationsWithMissingThumbnail(
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.creative.findMany({
      where: {
        thumbnailUrl: null,
        videoUrl: { not: null },
        archivedAt: null,
      },
      distinct: ['organizationId'],
      select: { organizationId: true },
      take: limit,
    });

    return rows.map((row) => row.organizationId);
  }
}
