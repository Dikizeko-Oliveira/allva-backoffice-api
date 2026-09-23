import { Injectable } from '@nestjs/common';
import { DomainEvent } from 'src/shared/domain/events/domain-event';
import { jobContextFrom } from 'src/shared/domain/events/job-context';
import {
  OnDomainEvent,
  jobIdFor,
} from 'src/shared/infrastructure/events/on-domain-event.decorator';
import { AlertsDispatcher } from '../queues/alerts.dispatcher';

/** O nome da ação no meio da frase — quem lê o alerta não fala enum. */
const ACTION_LABEL: Readonly<Record<string, string>> = {
  DUPLICATE_AD: 'duplicar o anúncio',
  REPLACE_COPY: 'trocar o texto do anúncio',
  REPLACE_CTA: 'trocar a chamada para ação do anúncio',
  REPLACE_CREATIVE: 'trocar o criativo do anúncio',
};

/**
 * Escritas que **criaram entidade e não terminaram** (`PARTIALLY_COMPLETED`).
 *
 * Consumidor de evento, como os outros listeners de `alerts` (§5.3 r.7): o
 * executor não chama `alerts`, avisa o barramento.
 *
 * **A severidade vem de `exposureRisk`.** Uma cópia criada cuja pausa não foi
 * confirmada pode estar veiculando — gasto que ninguém aprovou —, e isso é
 * `CRITICAL`. Uma sequência que parou num estado seguro (o anúncio novo nasceu
 * pausado e só faltou ligá-lo) é `WARNING`: não gasta a mais, mas deixa trabalho
 * pela metade na conta do cliente.
 */
@Injectable()
export class ActionAlertListener {
  constructor(private readonly dispatcher: AlertsDispatcher) {}

  @OnDomainEvent('action.executed')
  async onExecuted(event: DomainEvent<'action.executed'>): Promise<void> {
    const { payload } = event;
    if (payload.status !== 'PARTIALLY_COMPLETED') return;

    const exposed = payload.exposureRisk === true;
    const action = ACTION_LABEL[payload.actionType] ?? 'executar a ação';
    const created = payload.resultPlatformEntityId
      ? `o anúncio ${payload.resultPlatformEntityId}`
      : 'um anúncio novo';

    await this.dispatcher.raise(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        type: 'ACTION_PARTIALLY_COMPLETED',
        severity: exposed ? 'CRITICAL' : 'WARNING',
        title: exposed
          ? 'Anúncio criado pela Allva pode estar veiculando'
          : 'Ação concluída só em parte',
        message: exposed
          ? `Ao ${action}, a Allva criou ${created} na plataforma e não conseguiu ` +
            'confirmar que ele está pausado. Confira na plataforma e pause-o se ' +
            'estiver ativo.'
          : `Ao ${action}, a Allva criou ${created} na plataforma, mas não concluiu ` +
            'os passos seguintes. Nada passou a gastar a mais; revise o anúncio na ' +
            'plataforma.',
        subject: {
          kind: 'ACTION_EXECUTION',
          actionExecutionId: payload.executionId,
        },
        metadata: {
          actionType: payload.actionType,
          resultPlatformEntityId: payload.resultPlatformEntityId ?? null,
          exposureRisk: exposed,
        },
      },
      jobIdFor(event, 'action-partially-completed'),
    );
  }
}
