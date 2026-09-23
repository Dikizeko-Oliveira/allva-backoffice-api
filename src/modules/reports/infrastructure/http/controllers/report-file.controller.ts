import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import { GetReportFileUseCase } from '../../../application/use-cases/report-use-cases';

/**
 * O destino do botão "Baixar PDF" do e-mail.
 *
 * ## Por que não está em `ReportsController`
 *
 * Aquele controller carrega `EntitlementGuard` na classe, e o guard recusa
 * qualquer requisição sem `request.user`. Esta rota é justamente a que não tem
 * usuário na sessão — quem clica num link de e-mail não manda `Authorization`.
 * Marcá-la `@Public()` lá dentro contornaria o `AuthGuard` e ainda assim morreria
 * no de entitlement, então ela mora num controller sem aquele guard.
 *
 * A autorização não sumiu, mudou de carregador: está no token da URL, conferido
 * por `ReportDownloadTokenService`, e o que a conta pode ver continua sendo
 * decidido por `GetReportDownloadUseCase`.
 *
 * ## Por que redireciona em vez de devolver a URL
 *
 * O destino do link é um clique de e-mail: o browser precisa acabar no arquivo,
 * não num JSON. O 302 aponta para uma URL assinada emitida **neste instante**,
 * que é o que permite o e-mail durar mais que a assinatura.
 *
 * `302`, e não `301`: um permanente seria cacheado pelo browser e pelos
 * intermediários, e a URL assinada que ele guardaria vence — o próximo clique
 * iria direto para um link morto, sem passar por aqui.
 */
@ApiTags('Reports')
@Controller('/api/v1/reports')
export class ReportFileController {
  constructor(private readonly file: GetReportFileUseCase) {}

  @Get('/:id/file')
  @Public()
  // Fora do Swagger: não é superfície para integração, é o alvo de um link
  // assinado. Documentá-la só convidaria a chamá-la sem token.
  @ApiExcludeEndpoint()
  async downloadFile(
    @Param('id') id: string,
    @Query('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.file.execute(id, token ?? '');

    res.redirect(302, url);
  }
}
