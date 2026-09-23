import { PlanType } from 'src/modules/organizations/domain/plan-seat-limits';

/**
 * O plano que governa uma organização — a fonte de TODA guarda de plano.
 *
 * A leitura resolve a queda agendada sozinha: passada a data, o plano pendente
 * **é** o plano. Isso não é otimização, é correção — quem aplicaria a virada é o
 * webhook da Stripe, e um limite que dependesse dele continuaria entregando o
 * plano caro de graça se ele falhasse.
 */
export abstract class OrganizationPlanPortInterface {
  abstract findPlanTypeByOrganizationId(
    organizationId: string,
  ): Promise<PlanType | null>;

  /**
   * O plano que a organização **contratou** - valendo ou não.
   *
   * A diferença para `findPlanTypeByOrganizationId` é o estado da assinatura:
   * aquele responde "o que vale hoje" e fecha em nulo quando o acesso foi
   * revogado, que é o certo para toda capacidade de produto. Este responde "o
   * que foi contratado" e ignora o status.
   *
   * Existe por causa do suporte. `support-email` é uma `EnforcedFeatureKey`
   * como as outras, mas não é capacidade de produto: quem teve o plano
   * cancelado ou a assinatura vencida é justamente quem mais precisa abrir
   * chamado — em boa parte das vezes **sobre a própria cobrança**. Resolvendo
   * pelo plano em vigor, a recusa de acesso levava junto o canal de falar com
   * quem poderia resolvê-la.
   */
  abstract findContractedPlanTypeByOrganizationId(
    organizationId: string,
  ): Promise<PlanType | null>;

  /**
   * O plano vigente e a queda agendada **como gravados**, sem resolver a data.
   *
   * `findPlanTypeByOrganizationId` responde "o que vale agora" e já aplica a
   * queda vencida. A escolha de congelamento pergunta outra coisa — "para qual
   * plano esta organização vai, e quando" — e precisa das duas metades
   * separadas.
   */
  abstract findPlanScheduleByOrganizationId(organizationId: string): Promise<{
    planType: PlanType | null;
    pendingPlanType: PlanType | null;
    pendingPlanEffectiveAt: Date | null;
  } | null>;

  /**
   * Agenda a queda de plano para o fim do período pago.
   *
   * O cliente comprou o mês: `planId` fica onde está e o destino espera em
   * `pendingPlanId`.
   */
  abstract scheduleDowngrade(input: {
    organizationId: string;
    planId: string;
    effectiveAt: Date;
  }): Promise<void>;

  /**
   * Aplica a subida de plano **na hora**, e limpa qualquer queda pendente.
   *
   * A assimetria com o downgrade é deliberada e é a que o cliente espera: quem
   * paga mais hoje usa mais hoje; quem paga menos passa a usar menos quando o
   * que já pagou acabar.
   *
   * **Cria a linha se ela não existir.** Era um `updateMany`, que não falha
   * quando não encontra nada: uma organização sem assinatura absorvia o upgrade
   * em silêncio e seguia com plano nulo — que é como o cliente que acabou de
   * pagar continuava recebendo `PLAN_FEATURE_NOT_INCLUDED`. Toda organização
   * nasce com a linha desde `saveWithOwner`, mas o modo de falha vale ser
   * fechado no escritor: um upgrade pago que não chega ao produto é a pior
   * direção para errar.
   */
  abstract applyUpgrade(input: {
    organizationId: string;
    planId: string;
  }): Promise<void>;

  /**
   * Alinha as organizações **possuídas por uma conta** ao plano que ela paga.
   *
   * Chamado quando a Stripe confirma pagamento. `ChangeSubscriptionUseCase` já
   * propagava a troca de plano (via `AdAccountFreezeUseCase`), mas a **primeira**
   * assinatura não passa por lá: ela nasce em `CreateSubscriptionUseCase` como
   * `PENDING_PAYMENT` e é o webhook que a ativa. Sem esta propagação a
   * organização ficava no teste FREE para sempre — e como o FREE espelha o PRO,
   * um cliente do Individual recebia calado as capacidades do Profissional.
   *
   * **Não toca `pendingPlanId`**, de propósito, e é o que a distingue de
   * `applyUpgrade`: `invoice.paid` também chega em toda renovação, e limpar a
   * queda agendada ali faria o downgrade nunca aterrissar.
   *
   * Escopo por posse: fora do Enterprise a cota `organizations` é 1, e o
   * Enterprise não passa por autoatendimento (`assertSelfServePlan`).
   */
  abstract syncPlanForOwner(input: {
    ownerAccountId: string;
    planId: string;
  }): Promise<number>;

  /**
   * Fecha o acesso das organizações de uma conta que **parou de pagar**.
   *
   * É o par que faltava de `syncPlanForOwner`, e a ausência tinha preço. Só três
   * lugares escreviam `status` aqui — `applyUpgrade` e `syncPlanForOwner`, ambos
   * para `ACTIVE`, e a expiração de teste, que só varre `TRIALING`. Nada nunca
   * trazia uma organização de volta de `ACTIVE`: uma vez paga, ficava paga para
   * sempre no banco.
   *
   * O efeito era o pior possível. Cancelada a assinatura, a conta caía para
   * `PAYMENT_REQUIRED` e a organização seguia `ACTIVE` — e como `resolve()`
   * devolve o contexto **mais permissivo** entre as duas, o produto continuava
   * aberto. Pior ainda nas dezesseis guardas de `ENFORCED_FEATURE_KEYS`, que
   * leem a organização direto, sem passar pelo resolver: elas entregavam o plano
   * pago sem pagamento nenhum, indefinidamente.
   *
   * Devolve quantas linhas mudaram, para o chamador poder gritar no zero.
   */
  /**
   * Revoga a assinatura de **uma** organização — a contrapartida por
   * organização de `revokeForOwner`.
   *
   * O contrato Enterprise morre por organização, não por titular: uma holding
   * pode ter várias, cada uma com o seu acordo, e cancelar uma não encerra as
   * outras. `revokeForOwner` varre todas as do dono, o que está certo para a
   * assinatura de conta e errado aqui.
   */
  abstract revokeForOrganization(input: {
    organizationId: string;
    status: 'CANCELED' | 'EXPIRED';
  }): Promise<number>;

  abstract revokeForOwner(input: {
    ownerAccountId: string;
    status: 'CANCELED' | 'EXPIRED';
  }): Promise<number>;
}
