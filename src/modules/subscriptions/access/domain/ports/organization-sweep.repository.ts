import type {
  AccountAccessFacts,
  OrganizationAccessFacts,
} from '../organization-access';

/** O que a varredura dos jobs precisa saber de uma organização. */
export type OrganizationSweepSnapshot = {
  organizationId: string;
  deletedAt: Date | null;
  /** O carimbo de `organizations.access_closed_at`. */
  accessClosedAt: Date | null;
  /**
   * A assinatura da organização, com o contrato que a governa agora. Nula quando
   * não há linha — o resolver cai só nas assinaturas pessoais.
   */
  subscription: OrganizationAccessFacts | null;
  /** As assinaturas pessoais de quem alcança a organização: dono e membros ativos. */
  accounts: AccountAccessFacts[];
};

export abstract class OrganizationSweepRepositoryInterface {
  /** Organizações que não existem mais simplesmente não voltam. */
  abstract findSnapshots(
    organizationIds: readonly string[],
    now: Date,
  ): Promise<OrganizationSweepSnapshot[]>;

  /** Carimba só quem ainda não tem carimbo — reobservar não reinicia a janela. */
  abstract markAccessClosed(
    organizationIds: readonly string[],
    at: Date,
  ): Promise<void>;

  abstract clearAccessClosed(organizationIds: readonly string[]): Promise<void>;
}
