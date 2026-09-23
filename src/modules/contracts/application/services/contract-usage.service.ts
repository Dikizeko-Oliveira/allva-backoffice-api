import { Injectable } from '@nestjs/common';
import { AnalysisScopeRepositoryInterface } from 'src/modules/analysis-scope/domain/ports/analysis-scope.repository';
import { AdAccountsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { OrganizationsRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { SeatLimitService } from 'src/modules/organizations/application/services/seat-limit.service';
import type { AmendmentChanges } from 'src/modules/contracts/domain/entities';

/** O uso de uma dimensão contra o teto que o aditivo propõe para ela. */
export type DimensionUsage = {
  used: number;
  ceiling: number;
  /** O teto novo é menor que o uso de hoje. */
  exceeds: boolean;
};

export type AmendmentUsage = Partial<
  Record<'seats' | 'adAccounts' | 'monitoredAds' | 'organizations', DimensionUsage>
>;

/**
 * Quanto a organização usa de cada teto que o aditivo mexe.
 *
 * ## Para que serve, e para que **não** serve
 *
 * Serve para o operador ver o que está prestes a acontecer antes de assinar:
 * "hoje são 252 assentos e o aditivo pede 150". Não serve para recusar o
 * aditivo — uma redução datada para janeiro é assinada em setembro justamente
 * porque o cliente vai encolher até lá, e bloquear pelo uso de hoje impediria a
 * negociação legítima.
 *
 * ## As três dimensões não são iguais
 *
 * Assentos e contas de anúncio são **portões**: `assertCanInvite` e
 * `link-ad-account` recusam o próximo, e quem já está dentro continua. Ficar
 * acima do teto é um estado estável, que a saída natural resolve.
 *
 * Anúncios monitorados é uma **varredura**: baixar o teto de 500 para 200 tira
 * 300 anúncios da análise na madrugada seguinte, sem ninguém clicar em nada. É
 * a dimensão que justifica este serviço existir.
 *
 * ## Cada número vem de quem já o calcula
 *
 * Nenhuma contagem é reimplementada aqui. Um assento é uma participação ACTIVE
 * ou um convite pendente, e uma conta de anúncio ativa não é a congelada — são
 * regras com sutileza, e uma segunda versão delas divergiria em silêncio,
 * mostrando ao operador um número que o produto não usa.
 */
@Injectable()
export class ContractUsageService {
  constructor(
    private readonly seats: SeatLimitService,
    private readonly adAccounts: AdAccountsRepositoryInterface,
    private readonly analysisScope: AnalysisScopeRepositoryInterface,
    private readonly organizations: OrganizationsRepositoryInterface,
  ) {}

  /**
   * Só as dimensões que o aditivo toca.
   *
   * Nulo em `changes` é "inalterado", e contar o uso de um teto que ninguém
   * renegociou encheria a resposta de números que não pedem decisão nenhuma.
   */
  async forChanges(
    organizationId: string,
    changes: AmendmentChanges,
  ): Promise<AmendmentUsage> {
    const usage: AmendmentUsage = {};

    if (changes.maxSeats !== null) {
      const { used } = await this.seats.resolve(organizationId);
      usage.seats = this.compare(used, changes.maxSeats);
    }

    if (changes.maxAdAccounts !== null) {
      const used =
        await this.adAccounts.countActiveByOrganizationId(organizationId);
      usage.adAccounts = this.compare(used, changes.maxAdAccounts);
    }

    if (changes.maxMonitoredAds !== null) {
      const used = await this.analysisScope.countEligible(organizationId);
      usage.monitoredAds = this.compare(used, changes.maxMonitoredAds);
    }

    if (changes.maxOrganizations !== null) {
      const used = await this.countOrganizations(organizationId);
      usage.organizations = this.compare(used, changes.maxOrganizations);
    }

    return usage;
  }

  /** As dimensões em que o teto novo já nasce estourado. */
  static exceeded(usage: AmendmentUsage): string[] {
    return Object.entries(usage)
      .filter(([, dimension]) => dimension.exceeds)
      .map(([name]) => name);
  }

  private compare(used: number, ceiling: number): DimensionUsage {
    return { used, ceiling, exceeds: used > ceiling };
  }

  /**
   * O teto de organizações é do **titular**, e não desta organização.
   *
   * Uma holding negocia "até cinco organizações" e as distribui entre as
   * unidades; contar as da organização em que o contrato está daria sempre um.
   */
  private async countOrganizations(organizationId: string): Promise<number> {
    const organization = await this.organizations.findById(organizationId);
    if (!organization) return 0;

    return this.organizations.countByOwnerId(organization.ownerId);
  }
}
