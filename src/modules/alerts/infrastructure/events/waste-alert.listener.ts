import { Injectable } from '@nestjs/common';
import { DomainEvent } from 'src/shared/domain/events/domain-event';
import { jobContextFrom } from 'src/shared/domain/events/job-context';
import {
  OnDomainEvent,
  jobIdFor,
} from 'src/shared/infrastructure/events/on-domain-event.decorator';
import { findingLabel } from 'src/modules/waste/domain/contracts/finding-catalog';
import { AlertsDispatcher } from '../queues/alerts.dispatcher';

/**
 * O evitável em moeda-base, escrito como o usuário lê.
 *
 * `toFixed(2)` mais o código ISO produzia `198.01 BRL` — ponto decimal de outra
 * localidade e a moeda como sigla, num texto que o resto do produto escreve
 * `R$ 198,01`.
 */
function formatBase(value: number, currency: string): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
  }).format(value);
}

/**
 * `alerts` como consumidor de evento puro, do lado do desperdício (§5.3 r.7).
 *
 * No v1 o worker de waste injetava `CreateAlertUseCase` e passava
 * `referenceType: 'waste_item'` **sem** `referenceId`: o alerta nascia apontando
 * para lugar nenhum. Aqui o sujeito é escolhido neste arquivo, contra o conjunto
 * fechado de seis FKs que o `CHECK` de exclusividade cobra no banco — e o
 * `WASTE_ITEM` é justamente o sujeito que o v1 não conseguia preencher.
 */
@Injectable()
export class WasteAlertListener {
  constructor(private readonly dispatcher: AlertsDispatcher) {}

  /**
   * **Só `HIGH` e `CRITICAL` viram alerta**, e o corte não é economia de
   * notificação: um ciclo diário sobre uma conta grande produz dezenas de
   * achados `LOW`, e alertar sobre todos ensina o usuário a ignorar a caixa
   * antes do primeiro caso que importa. Os demais continuam na lista, que é onde
   * se olha por vontade própria.
   *
   * Oportunidade também não alerta: ela não é urgente por natureza — é dinheiro
   * que **poderia** ser ganho, e interromper o dia de alguém por isso inverte a
   * relação entre as duas grandezas de §10.1.
   */
  @OnDomainEvent('waste.detected')
  async onDetected(event: DomainEvent<'waste.detected'>): Promise<void> {
    if (event.payload.kind !== 'WASTE') return;
    if (
      event.payload.priority !== 'HIGH' &&
      event.payload.priority !== 'CRITICAL'
    ) {
      return;
    }

    const { avoidableDaily } = event.payload;

    await this.dispatcher.raise(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        type: 'WASTE_DETECTED',
        severity:
          event.payload.priority === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        title: 'Desperdício detectado em um anúncio',
        // A mensagem carrega o **evitável**, não o incorrido: é o número sobre o
        // qual ainda há o que fazer. Alertar pelo dano acumulado convida a uma
        // ação que não recupera nada.
        //
        // O achado entra pelo rótulo, não pelo enum: `OVERLAPPING_DELIVERY` é
        // chave de fingerprint e de filtro, e num alerta obrigava o usuário a
        // deduzir o problema a partir de uma constante de código - inclusive no
        // e-mail, que repete esta mesma `message`.
        message:
          `${findingLabel(event.payload.type)}: ` +
          `${formatBase(avoidableDaily.valueBase, avoidableDaily.baseCurrency)} ` +
          `por dia enquanto nada for feito.`,
        subject: { kind: 'WASTE_ITEM', wasteItemId: event.payload.wasteItemId },
        metadata: {
          adId: event.payload.adId,
          incurredBase: event.payload.incurred.valueBase,
        },
      },
      jobIdFor(event, 'waste-detected'),
    );
  }

  /**
   * A denormalização divergiu (C3, §5.4 r.2).
   *
   * O alerta é operacional, não de produto: a coluna **já foi corrigida** quando
   * o evento sai, e o que ele reporta é que ela estava errada. Divergência
   * recorrente é bug do worker, e sem o alerta ela seria invisível — a tela lê
   * exatamente a coluna que se corrigiu.
   */
  @OnDomainEvent('denormalization.drift_detected')
  async onDrift(
    event: DomainEvent<'denormalization.drift_detected'>,
  ): Promise<void> {
    await this.dispatcher.raise(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        type: 'DENORMALIZATION_DRIFT',
        severity: 'WARNING',
        title: 'Um número de desperdício estava fora de sincronia',
        message:
          `${event.payload.field} dizia ${event.payload.stored} e a agregação ` +
          `diz ${event.payload.actual}. A coluna foi corrigida pela agregação.`,
        subject: { kind: 'AD', adId: event.payload.adId },
        metadata: { adAccountId: event.payload.adAccountId },
      },
      jobIdFor(event, 'denormalization-drift'),
    );
  }
}
