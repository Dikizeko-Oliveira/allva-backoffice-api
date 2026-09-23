import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  type PlatformPermission,
  roleHasPlatformPermission,
} from 'src/modules/accounts/domain/platform-rbac';
import { assertPlatformPermission } from 'src/modules/accounts/application/platform-authorization';

/**
 * "Esta conta pode fazer isto na plataforma?" — por **capacidade**.
 *
 * Nasceu como `assertOperator`, binário: `ALLVA_OPERATOR` e `ALLVA_ADMIN`
 * entravam em tudo, e eram equivalentes em todos os 22 call sites. Isso
 * bastava enquanto só havia dois papéis internos, e era exatamente o que
 * impedia criar os outros: acrescentar `ALLVA_SUPPORT` ao array daria ao
 * suporte, em silêncio, poder de emitir fatura e cancelar contrato. Nenhum
 * teste falharia e nenhum log registraria.
 *
 * Agora cada call site nomeia a permissão que exige, e a matriz em
 * `accounts/domain/platform-rbac.ts` decide. O método binário foi **removido**,
 * não deprecado: deixá-lo de pé é convidar o próximo call site a usá-lo.
 *
 * Fica em `accounts` porque a resposta mora na conta.
 */
@Injectable()
export class PlatformRoleService {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
  ) {}

  /** Recusa com `ACCOUNT_NOT_AUTHORIZED` e a permissão que faltou. */
  async assertPermission(
    actorId: string,
    permission: PlatformPermission,
  ): Promise<void> {
    const actor = await this.accountsRepository.findById(actorId);

    if (!actor) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    assertPlatformPermission(actor, permission);
  }

  /**
   * O **alvo** de uma ação tem esta capacidade?
   *
   * Distinto de `assertPermission`, que responde pelo **ator** e recusa.
   * Atribuir um chamado a alguém exige que esse alguém possa atendê-lo, e a
   * recusa é de quem atribui — "responsável inválido" não é "você não pode".
   * Conta inexistente devolve `false`: para quem atribui, um id que não
   * existe e um id sem a capacidade pedem a mesma resposta.
   */
  async accountHasPermission(
    accountId: string,
    permission: PlatformPermission,
  ): Promise<boolean> {
    const account = await this.accountsRepository.findById(accountId);

    return account
      ? roleHasPlatformPermission(account.role, permission)
      : false;
  }
}
