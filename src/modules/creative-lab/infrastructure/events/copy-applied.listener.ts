import { Injectable } from '@nestjs/common';
import { DomainEvent } from 'src/shared/domain/events/domain-event';
import { jobContextFrom } from 'src/shared/domain/events/job-context';
import {
  OnDomainEvent,
  jobIdFor,
} from 'src/shared/infrastructure/events/on-domain-event.decorator';
import { CopyStudioDispatcher } from '../queues/copy-studio.dispatcher';

/**
 * **O elo que fecha o laço da Allva.**
 *
 * Hoje o produto vai de anúncio a recomendação. Com a geração de copy ele pode
 * ir mais longe — variação, publicação, medição — e a única peça que faltava era
 * saber *qual variação foi ao ar*. Este listener é essa peça.
 *
 * ## Por que evento, e não chamada direta
 *
 * `platform-actions` poderia carimbar a variante ao executar. Não deve: faria o
 * executor depender de um produtor específico de conteúdo, que é exatamente a
 * inversão já recusada em relação a `recommendations` — *"uma ação `USER_DIRECT`
 * não tem recomendação nenhuma por trás"*. O mesmo vale aqui: um `REPLACE_COPY`
 * com texto digitado à mão não tem variação nenhuma por trás, e o executor não
 * precisa saber que o Copy Studio existe.
 *
 * ## Por que dígito, e não texto
 *
 * O evento carrega o **dígito** do que foi ao ar, nunca o texto. Casar por
 * dígito é o que torna o vínculo preciso: se a pessoa editou a variação antes de
 * confirmar — e R14 permite, desde que confirme o texto final —, o que foi
 * publicado **não é** a variação, e atribuí-la mentiria sobre a autoria numa
 * medição que existe para responder "o que a Allva sugeriu funcionou?".
 *
 * ## Por que só enfileira
 *
 * `EventEmitter2` é **síncrono** (⊕10): gravar aqui poria a latência desta
 * escrita dentro do emissor, e `perform-action` passaria a esperar o Copy Studio
 * para terminar de executar uma ação em mídia paga. O handler decide **se** o
 * evento é dele; quem escreve é o worker.
 */
@Injectable()
export class CopyAppliedListener {
  constructor(private readonly dispatcher: CopyStudioDispatcher) {}

  @OnDomainEvent('action.executed')
  async onExecuted(event: DomainEvent<'action.executed'>): Promise<void> {
    const { payload } = event;

    if (
      payload.actionType !== 'REPLACE_COPY' &&
      payload.actionType !== 'REPLACE_CTA'
    ) {
      return;
    }

    // Sem dígito não há como casar: a ação carregou texto que não veio daqui, ou
    // não carregou texto nenhum. As duas produzem o mesmo silêncio correto.
    if (!payload.appliedContentDigest) return;

    if (payload.status !== 'SUCCEEDED') return;

    await this.dispatcher.linkApplied(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        adId: payload.adId,
        contentDigest: payload.appliedContentDigest,
        executionId: payload.executionId,
      },
      jobIdFor(event, payload.executionId),
    );
  }
}
