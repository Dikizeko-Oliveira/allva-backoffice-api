import { BadRequestException } from '@nestjs/common';
import {
  PlanType,
  isContactSalesPlan,
} from 'src/modules/plans/domain/plan-catalog';

/**
 * A recusa de contratar um plano negociado, **uma só para as três portas**.
 *
 * São três caminhos independentes até a mesma cobrança indevida — criar
 * assinatura, trocar de plano e abrir checkout hospedado —, e nenhum deles
 * perguntava nada: o `planId` do Enterprise seguia direto para a Stripe e abria
 * uma cobrança de R$ 1.497, que é o piso de vitrine da landing e não o preço de
 * contrato nenhum. Nada de organização, assentos ou cotas negociadas teria sido
 * combinado, e desfazer envolve estorno.
 *
 * Uma função e não três `if`: uma quarta porta é questão de tempo, e três
 * cópias divergem antes disso. O `redirectTo` está na resposta porque a saída
 * existe e é concreta — a tela leva ao comercial em vez de dar um beco.
 */
export function assertSelfServePlan(type: PlanType): void {
  if (!isContactSalesPlan(type)) return;

  throw new BadRequestException({
    code: 'PLAN_REQUIRES_SALES_CONTACT',
    message:
      'This plan is negotiated with sales and cannot be contracted directly',
    redirectTo: '/sales',
  });
}
