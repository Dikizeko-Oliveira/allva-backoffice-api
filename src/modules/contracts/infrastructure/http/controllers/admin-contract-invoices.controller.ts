import { Controller, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { SettleContractInvoiceUseCase } from '../../../application/use-cases/settle-contract-invoice.usecase';

/**
 * A baixa manual de uma fatura de contrato.
 *
 * Rota própria, fora de `/admin/contracts/:id`, porque a operação é sobre a
 * **fatura** e não sobre o contrato: o operador chega nela pelo extrato ou pelo
 * número que o financeiro mandou, e não navegando pelo acordo.
 *
 * Só fatura de contrato se baixa por aqui. A de autoatendimento tem o webhook
 * da Stripe como fonte da verdade do pagamento, e marcá-la à mão faria o
 * produto acreditar num dinheiro que o provedor não confirmou.
 */
@ApiTags('Contratos Enterprise')
@ApiBearerAuth()
@Controller('/api/v1/admin/invoices')
export class AdminContractInvoicesController {
  constructor(private readonly settleInvoice: SettleContractInvoiceUseCase) {}

  @Post(':id/settle')
  @ApiOperation({
    summary: 'Registrar o pagamento recebido fora do provedor',
    description:
      'Exige a permissão de plataforma `billing:manage`. Além de marcar a fatura como ' +
      'paga, abre o acesso de um contrato que esperava o pré-pagamento e ' +
      'reabre um suspenso por inadimplência — mas não um suspenso pelo ' +
      'operador, que só ação humana desfaz.',
  })
  async settle(@Param('id') id: string, @CurrentUser() user: Account) {
    return this.settleInvoice.execute(id, user.id);
  }
}
