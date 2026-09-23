import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GenerateUploadUrlUseCase } from 'src/modules/upload/application/use-cases/generate-upload-url.usecase';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';

@ApiTags('Upload de arquivos')
@ApiBearerAuth()
@Controller('/api/v1/uploads')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
export class UploadController {
  constructor(
    private readonly generateUploadUrlUseCase: GenerateUploadUrlUseCase,
  ) {}

  @Post('presigned-url')
  @ApiOperation({ summary: 'Gerar URL de upload presigned' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        mimeType: { type: 'string' },
        campaignName: { type: 'string' },
      },
    },
  })
  async generateUploadUrl(
    @Body() body: { filename: string; mimeType: string; campaignName?: string },
  ) {
    if (!body.filename || !body.mimeType) {
      throw new BadRequestException('Filename and mimeType are required');
    }
    return this.generateUploadUrlUseCase.execute(
      body.filename,
      body.mimeType,
      body.campaignName,
    );
  }
}
