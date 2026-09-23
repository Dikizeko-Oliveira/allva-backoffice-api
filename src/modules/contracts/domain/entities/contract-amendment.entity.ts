import { randomUUID } from 'crypto';
import { NegotiatedLimits } from './enterprise-contract.entity';

/**
 * O que um aditivo pode mudar.
 *
 * Colunas tipadas, e não um `Json` de mudanças livres, pelo mesmo motivo dos
 * tetos do contrato: são cinco números conhecidos, quatro deles mapeando um a
 * um para `OrganizationQuota`. Um mapa aberto aceitaria a chave errada em
 * silêncio e só falharia na hora de escrever a cota — quando o operador já
 * fechou a tela.
 *
 * **Nulo significa inalterado**, e não "herda o plano". É a diferença que o
 * contrato faz com os mesmos campos, e confundir as duas leituras zeraria um
 * teto que a negociação nem tocou.
 */
export type AmendmentChanges = NegotiatedLimits & {
  billingAmount: number | null;
};

export class AmendmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AmendmentError';
  }
}

type AmendmentProps = {
  id: string;
  contractId: string;
  organizationId: string;
  number: string;
  effectiveAt: Date;
  appliedAt: Date | null;
  reason: string;
  changes: AmendmentChanges;
  previous: AmendmentChanges;
  createdBy: string;
  createdAt: Date;
};

export type CreateAmendmentProps = Omit<
  AmendmentProps,
  'id' | 'appliedAt' | 'previous' | 'createdAt'
>;

const NADA_MUDOU: AmendmentChanges = {
  billingAmount: null,
  maxSeats: null,
  maxAdAccounts: null,
  maxMonitoredAds: null,
  maxOrganizations: null,
  llmDailyBudgetBase: null,
};

/**
 * Uma alteração negociada no meio da vigência.
 *
 * ## Por que não é um `UPDATE` no contrato
 *
 * Antes da ativação, um erro de digitação se conserta editando o contrato —
 * ninguém está usando nada ainda. Depois dela o cliente já opera dentro do que
 * foi provisionado, e mudar em silêncio apaga o que ele contratou. O aditivo é
 * o registro de que a mudança foi acordada, de quando passa a valer e do que
 * havia antes; é o que o comercial lê seis meses depois para explicar por que a
 * fatura mudou de valor.
 *
 * ## Criar e aplicar são dois passos
 *
 * Criar é um documento. **Aplicar** escreve na cota da organização e no
 * contrato, e só acontece quando `effectiveAt` chega — porque é assim que se
 * negocia: "a partir de janeiro passam a ser 250 assentos". Um aditivo assinado
 * hoje com vigência em janeiro fica pendente até lá, e é o job diário que o
 * aplica.
 */
export class ContractAmendment {
  private constructor(private props: AmendmentProps) {}

  static create(props: CreateAmendmentProps): ContractAmendment {
    ContractAmendment.assertChangesSomething(props.changes);
    ContractAmendment.assertPositive(props.changes);

    if (!props.reason.trim()) {
      throw new AmendmentError(
        'AMENDMENT_REASON_REQUIRED',
        'An amendment must say why it was agreed',
      );
    }

    return new ContractAmendment({
      ...props,
      id: randomUUID(),
      appliedAt: null,
      previous: { ...NADA_MUDOU },
      createdAt: new Date(),
    });
  }

  static restore(props: AmendmentProps): ContractAmendment {
    return new ContractAmendment(props);
  }

  /**
   * Cinco nulos é um documento sem conteúdo.
   *
   * Aceitá-lo encheria o histórico do cliente de linhas que não explicam nada,
   * e a primeira pergunta de quem abrisse uma delas seria "o que mudou aqui?".
   */
  private static assertChangesSomething(changes: AmendmentChanges): void {
    const touched = Object.values(changes).some((value) => value !== null);

    if (!touched) {
      throw new AmendmentError(
        'AMENDMENT_EMPTY',
        'An amendment must change at least one negotiated term',
      );
    }
  }

  /**
   * Zero não é uma redução: é uma conta fechada.
   *
   * Encerrar um cliente se faz suspendendo ou cancelando o contrato, que deixa
   * rastro do porquê. Um aditivo que zera assentos fecharia o acesso com a
   * aparência de um ajuste de escopo.
   */
  private static assertPositive(changes: AmendmentChanges): void {
    for (const [field, value] of Object.entries(changes)) {
      if (value !== null && value <= 0) {
        throw new AmendmentError(
          'AMENDMENT_INVALID_VALUE',
          `Amendment ${field} must be greater than zero`,
        );
      }
    }
  }

  /** Chegou a data e a mudança ainda não foi escrita? */
  isDue(now: Date = new Date()): boolean {
    return this.props.appliedAt === null && this.props.effectiveAt <= now;
  }

  /**
   * Carimba o que havia antes e fecha o aditivo.
   *
   * Só guarda as dimensões que o aditivo toca: registrar o valor anterior de um
   * teto que a negociação não mexeu sugeriria que ele foi negociado.
   *
   * Recusa a segunda aplicação, e é isso que torna o job seguro para rodar de
   * novo: na segunda passada o contrato já mostra 250, então carimbar de novo
   * gravaria 250 como "o que havia antes" e o registro dos 150 estaria perdido.
   */
  markApplied(current: AmendmentChanges, now: Date = new Date()): void {
    if (this.props.appliedAt !== null) {
      throw new AmendmentError(
        'AMENDMENT_ALREADY_APPLIED',
        'This amendment has already been applied',
      );
    }

    this.props.previous = {
      billingAmount: this.snapshot('billingAmount', current),
      maxSeats: this.snapshot('maxSeats', current),
      maxAdAccounts: this.snapshot('maxAdAccounts', current),
      maxMonitoredAds: this.snapshot('maxMonitoredAds', current),
      maxOrganizations: this.snapshot('maxOrganizations', current),
      llmDailyBudgetBase: this.snapshot('llmDailyBudgetBase', current),
    };
    this.props.appliedAt = now;
  }

  private snapshot(
    field: keyof AmendmentChanges,
    current: AmendmentChanges,
  ): number | null {
    return this.props.changes[field] === null ? null : current[field];
  }

  /**
   * Os tetos que a organização passa a ter.
   *
   * Sobreposição, e não substituição: o que o aditivo não menciona continua
   * como estava. Trocar o conjunto inteiro apagaria limites que ninguém
   * renegociou.
   */
  applyTo(limits: NegotiatedLimits): NegotiatedLimits {
    return {
      maxSeats: this.props.changes.maxSeats ?? limits.maxSeats,
      maxAdAccounts: this.props.changes.maxAdAccounts ?? limits.maxAdAccounts,
      maxMonitoredAds:
        this.props.changes.maxMonitoredAds ?? limits.maxMonitoredAds,
      maxOrganizations:
        this.props.changes.maxOrganizations ?? limits.maxOrganizations,
      llmDailyBudgetBase:
        this.props.changes.llmDailyBudgetBase ?? limits.llmDailyBudgetBase,
    };
  }

  get id() {
    return this.props.id;
  }
  get contractId() {
    return this.props.contractId;
  }
  get organizationId() {
    return this.props.organizationId;
  }
  get number() {
    return this.props.number;
  }
  get effectiveAt() {
    return this.props.effectiveAt;
  }
  get appliedAt() {
    return this.props.appliedAt;
  }
  get reason() {
    return this.props.reason;
  }
  get changes(): AmendmentChanges {
    return { ...this.props.changes };
  }
  get previous(): AmendmentChanges {
    return { ...this.props.previous };
  }
  get createdBy() {
    return this.props.createdBy;
  }
  get createdAt() {
    return this.props.createdAt;
  }
}
