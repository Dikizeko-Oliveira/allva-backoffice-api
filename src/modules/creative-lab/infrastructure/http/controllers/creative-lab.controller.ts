import { Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { parkedFeature } from 'src/shared/infrastructure/http/parked-feature';

/**
 * Creative Lab — o que **sobrou** aqui depois de A2-S9.
 *
 * O v1 pontuava o criativo: agregava métrica de nível CREATIVE e produzia um
 * score por criativo. A v2.0 analisa o **par (Creative, Ad)** — o mesmo criativo
 * em cinco anúncios tem cinco desempenhos, e a média não descreve nenhum (§3.4).
 * A entrada mudou de tabela e a unidade de análise mudou de conceito: não há
 * adaptação, há reescrita.
 *
 * **Preservados aqui, sem consumidor até A2-S4:** as cinco calculadoras puras de
 * `domain/scoring/` (Apêndice C — mudam de endereço e de entrada, não de lógica)
 * e o extrator de primeiro frame em `infrastructure/media/` (D7).
 *
 * `POST /creatives/upload` **não volta em S4**: a superfície de pré-veiculação
 * está fora do escopo da v2.0 (D7.1). Um criativo que não veicula não tem gasto,
 * não tem métrica e não tem desperdício — analisá-lo seria predição pura, a
 * mesma classe de feature que D1 removeu.
 *
 * **`POST /{id}/optimize` e `GET /{id}/optimization-result` saíram em A2-S9**
 * (entrega 5). Não foram renomeadas: a unidade de análise mudou de conceito. A
 * sucessora é `POST /ads/{id}/analyze`, e ela analisa o par `(Creative, Ad)` —
 * o mesmo criativo em cinco anúncios tem cinco desempenhos, e um endpoint
 * indexado por criativo não tem como devolver cinco respostas (§3.4).
 *
 * **`GET /creatives`, `/creatives/{id}` e `/creatives/insights` também saíram
 * daqui**, e não por remoção: viraram **contexto**, servidas por
 * `AdContextController` ao lado de `/campaigns` e `/ad-sets`. É onde elas
 * pertencem — situam o anúncio e não derivam número —, e o prefixo `/creatives`
 * passa a ser dividido entre dois módulos, cada um com o que é seu (D3).
 *
 * O que resta aqui é o **upload pré-veiculação**, declarado fora do escopo da
 * v2.0 (D7.1) e mantido para que a recusa tenha um lugar e um motivo.
 */
@ApiTags('Creative Lab')
@ApiBearerAuth('access-token')
@Controller('/api/v1/creatives')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@ApiServiceUnavailableResponse({
  description:
    'Superfície de pré-veiculação fora do escopo da v2.0 (D7.1). A análise do ' +
    'par (Creative, Ad) é servida por POST /ads/{id}/analyze.',
  /**
   * O corpo é declarado inline porque **não é nenhum dos dois dialetos**: nem o
   * erro tipado de §7.0.4, nem o legado. É a forma da rota parqueada, e existe
   * para o cliente distinguir "isto volta" de "isto nunca existiu" — 404 faria
   * ele apagar o caminho, e 200 com lista vazia afirmaria que não há criativo.
   */
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', example: 'FEATURE_REBUILDING' },
      message: { type: 'string' },
      feature: { type: 'string' },
      returnsIn: {
        type: 'string',
        example: 'nenhum sprint — a análise do anúncio veiculado o substitui',
      },
    },
  },
})
export class CreativeLabController {
  @Post('/upload')
  @ApiOperation({
    summary: '[Removido] Upload pré-veiculação — fora do escopo da v2.0 (D7.1)',
  })
  upload(): never {
    return parkedFeature(
      'O upload de criativo pré-veiculação saiu do escopo da v2.0 (D7.1) e',
      'nenhum sprint — a análise do anúncio veiculado o substitui',
    );
  }
}
