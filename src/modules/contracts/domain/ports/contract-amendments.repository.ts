import { ContractAmendment } from '../entities';

/**
 * Um aditivo cuja data chegou e que ninguém escreveu ainda.
 *
 * O job diário varre por esta forma, e ela traz o contrato junto porque aplicar
 * exige os dois: o aditivo diz o que muda, o contrato diz o que havia — e é
 * esse "havia" que o aditivo carimba antes de ser fechado.
 */
export type DueAmendmentRef = {
  amendmentId: string;
  contractId: string;
  organizationId: string;
};

export abstract class ContractAmendmentsRepositoryInterface {
  abstract findById(id: string): Promise<ContractAmendment | null>;

  /** O histórico do contrato, do mais antigo para o mais novo. */
  abstract listByContractId(contractId: string): Promise<ContractAmendment[]>;

  abstract save(amendment: ContractAmendment): Promise<void>;
  abstract update(amendment: ContractAmendment): Promise<void>;

  /**
   * Aditivos vencidos e ainda não aplicados.
   *
   * `limit` porque é um job: uma carteira grande com muitos aditivos datados
   * para o mesmo dia não pode virar uma transação sem fim que segura conexão do
   * pool. A próxima passada pega o resto.
   */
  abstract listDue(now: Date, limit: number): Promise<DueAmendmentRef[]>;

  /**
   * O próximo número do contrato — `ENT-2026-0012/A2`.
   *
   * Sequencial por contrato, e não global: é assim que o aditivo é citado no
   * documento, e um número global não diria a que acordo ele pertence.
   */
  abstract nextAmendmentNumber(
    contractId: string,
    contractNumber: string,
  ): Promise<string>;
}
