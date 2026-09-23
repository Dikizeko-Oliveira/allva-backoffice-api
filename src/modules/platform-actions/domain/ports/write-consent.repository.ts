import type { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import type { ConsentState } from 'src/modules/platform-actions/domain/write-guards';

export type WriteConsentView = {
  id: string;
  integrationId: string;
  organizationId: string;
  grantedByAccountId: string;
  grantedAt: Date;
  revokedAt: Date | null;
  revokedByAccountId: string | null;
  consentedActionTypes: AdActionType[];
};

export abstract class WriteConsentRepositoryInterface {
  /**
   * O estado de consentimento desta integração, como a cadeia de guardas o lê.
   *
   * Devolve `ConsentState` e não a linha porque a distinção entre *"nunca
   * consentiu"* e *"revogou"* é do domínio, não da tabela: a segunda tem data e
   * pede uma mensagem diferente, e resolver isso no use case espalharia a regra
   * por todo chamador.
   */
  abstract stateFor(input: {
    organizationId: string;
    integrationId: string;
  }): Promise<ConsentState>;

  /**
   * Concede — e **revoga o consentimento anterior no mesmo ato**.
   *
   * Sem isso, ampliar os tipos consentidos deixaria duas linhas vivas para a
   * mesma integração, e a leitura teria de escolher uma. Qualquer critério de
   * desempate aqui seria arbitrário, e o errado autorizaria mais do que o
   * usuário concedeu por último.
   */
  abstract grant(input: {
    organizationId: string;
    integrationId: string;
    grantedByAccountId: string;
    consentedActionTypes: AdActionType[];
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<WriteConsentView>;

  /** Revogação é **soft**: a trilha de quem autorizou o quê não se apaga. */
  abstract revoke(input: {
    organizationId: string;
    integrationId: string;
    revokedByAccountId: string;
  }): Promise<WriteConsentView | null>;

  abstract listFor(input: {
    organizationId: string;
  }): Promise<WriteConsentView[]>;
}
