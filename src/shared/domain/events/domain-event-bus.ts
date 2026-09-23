import { DomainEvent } from './domain-event';
import { DomainEventMap, DomainEventName } from './domain-event-map';
import { JobContext } from './job-context';

/**
 * O que é preciso para emitir: o contexto que atravessou a fila **mais** o
 * tenant.
 *
 * §5.6.1 declara `emitFrom(ctx: JobContext, …)` e uma envelope com
 * `organizationId: string` obrigatório — e `JobContext` (§5.6.2) não tem onde
 * guardá-lo. Alguém tem que fechar essa lacuna, e as duas alternativas eram
 * piores: ler a organização de um store ambiente faz o worker emitir para o
 * tenant errado quando o store está vazio (o caso comum fora de requisição
 * HTTP), e pô-la no payload cria duas fontes de verdade para o mesmo campo.
 *
 * Exigi-la no contexto de emissão significa que **nenhum evento sai sem tenant
 * declarado**, verificado por `tsc` e não por revisão. `JobContext` continua
 * exatamente como o documento o define, porque ele é o contrato da fila — e
 * jobs de plataforma inteira (câmbio, partições) o carregam sem ter uma
 * organização única para declarar.
 */
export type EmitContext = JobContext & { organizationId: string };

/** Junta o contexto da fila com o tenant do trabalho sendo feito agora. */
export function emitContext(
  ctx: JobContext,
  organizationId: string,
): EmitContext {
  return { ...ctx, organizationId };
}

/**
 * O barramento de eventos de domínio (arquitetura §5.6).
 *
 * Port como `abstract class` — a convenção do repositório para tudo que o
 * domínio declara e a infraestrutura implementa (§16.6).
 *
 * `emitFrom` preenche a envelope inteira a partir do contexto: `eventId` novo,
 * `eventVersion` da tabela normativa, `occurredAt`, `correlationId` herdado e
 * `causationId` apontando para quem causou. Não existe outro caminho de
 * emissão — um `emit(event)` cru devolveria ao chamador a chance de errar
 * justamente os campos que sustentam a rastreabilidade.
 *
 * Devolve o evento emitido, o que o documento (`: void`) não previa: quem emite
 * dois eventos em sequência precisa do `eventId` do primeiro para encadear o
 * segundo, e sem retorno esse encadeamento seria impossível de escrever.
 */
export abstract class DomainEventBus {
  abstract emitFrom<K extends DomainEventName>(
    ctx: EmitContext,
    name: K,
    payload: DomainEventMap[K],
  ): DomainEvent<K>;
}
