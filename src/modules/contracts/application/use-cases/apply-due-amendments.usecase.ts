import { Injectable, Logger } from '@nestjs/common';
import { ContractAmendmentsRepositoryInterface } from 'src/modules/contracts/domain/ports/contract-amendments.repository';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';
import { ContractAmendmentApplier } from '../services/contract-amendment-applier';

export type ApplyAmendmentsResult = {
  scanned: number;
  applied: number;
};

/**
 * Escreve os aditivos cuja data chegou.
 *
 * Um aditivo assinado em setembro com vigência em janeiro fica pendente até lá
 * — é assim que se negocia, e aplicar na assinatura entregaria de graça quatro
 * meses que o cliente não contratou. Alguém precisa acordar em janeiro e
 * escrever a mudança: é este.
 *
 * Diferente do job de teste gratuito, aqui a leitura **não** compensa o atraso.
 * O acesso a mais assentos vem de `organization_quotas`, uma linha gravada, e
 * não de um cálculo — então se este job não rodar, o cliente simplesmente não
 * recebe o que comprou. É a razão de ele registrar cada falha individualmente
 * em vez de abortar a passada inteira.
 */
@Injectable()
export class ApplyDueAmendmentsUseCase {
  private readonly logger = new Logger(ApplyDueAmendmentsUseCase.name);

  constructor(
    private readonly amendments: ContractAmendmentsRepositoryInterface,
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly applier: ContractAmendmentApplier,
  ) {}

  async execute(input?: { limit?: number }): Promise<ApplyAmendmentsResult> {
    const limit = input?.limit ?? 200;
    const now = new Date();

    const due = await this.amendments.listDue(now, limit);
    let applied = 0;

    for (const ref of due) {
      try {
        await this.applyOne(ref.amendmentId, now);
        applied += 1;
      } catch (error) {
        /**
         * Um aditivo que falha não pode levar a passada inteira junto: vários
         * clientes comprarem expansão para o mesmo dia é normal, e segurar
         * todos por causa de um contrato num estado inesperado transformaria um
         * problema pontual numa parada geral.
         */
        this.logger.warn(
          `Failed to apply amendment=${ref.amendmentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (applied > 0) {
      this.logger.log(
        `Contract amendments applied: scanned=${due.length} applied=${applied}`,
      );
    }

    return { scanned: due.length, applied };
  }

  private async applyOne(amendmentId: string, now: Date): Promise<void> {
    const amendment = await this.amendments.findById(amendmentId);
    // Corrida com a aplicação imediata do operador: quem chegou primeiro
    // venceu, e reaplicar carimbaria o depois como se fosse o antes.
    if (!amendment || !amendment.isDue(now)) return;

    const contract = await this.contracts.findById(amendment.contractId);
    if (!contract) return;

    await this.applier.apply(amendment, contract, {
      now,
      appliedBy: 'schedule',
    });
  }
}
