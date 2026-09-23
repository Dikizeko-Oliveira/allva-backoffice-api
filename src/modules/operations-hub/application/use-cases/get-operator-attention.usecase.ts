import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  isPlatformRole,
  permissionsForRole,
} from 'src/modules/accounts/domain/platform-rbac';
import {
  ATTENTION_SEVERITIES,
  signalsVisibleTo,
} from 'src/modules/operations-hub/domain/attention-signals';
import { AttentionCountsReaderInterface } from 'src/modules/operations-hub/domain/ports';
import { OperatorAttentionOutputDto } from '../dtos';

/**
 * `GET /api/v1/admin/attention` — o "Requires attention" do Operations Hub e
 * os contadores dos cards de área.
 *
 * ## Quem entra
 *
 * Qualquer papel de plataforma. O hub é a primeira tela de **todo** operador,
 * então a rota não exige uma permissão específica — o que muda de um papel
 * para outro é quais sinais voltam. Conta de cliente (`USER`) recebe 403 com o
 * mesmo `ACCOUNT_NOT_AUTHORIZED` das outras superfícies administrativas, e não
 * uma lista vazia: lista vazia diria "você é operador e não há nada", que é
 * mentira para quem não é operador.
 *
 * ## O que não entra
 *
 * Nada que dependa de processo interno de atendimento (SLA estourado,
 * escalonamento, fila por operador): isso é do backend próprio do backoffice,
 * e o hub de lá compõe os dois (`docs/backoffice-api.md`).
 */
@Injectable()
export class GetOperatorAttentionUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly countsReader: AttentionCountsReaderInterface,
  ) {}

  async execute(
    actorId: string,
    now: Date = new Date(),
  ): Promise<OperatorAttentionOutputDto> {
    const actor = await this.accountsRepository.findById(actorId);

    if (!actor) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    if (!isPlatformRole(actor.role)) {
      throw new ForbiddenException({
        code: 'ACCOUNT_NOT_AUTHORIZED',
        message: 'Account not authorized: requires a platform role',
      });
    }

    const visible = signalsVisibleTo(permissionsForRole(actor.role));
    const counts = await this.countsReader.count(
      visible.map((signal) => signal.key),
      now,
    );

    // `sort` é estável: dentro da mesma severidade vale a ordem do catálogo.
    const signals = visible
      .map((signal) => ({
        key: signal.key,
        permission: signal.permission,
        severity: signal.severity,
        count: counts[signal.key] ?? null,
      }))
      .sort(
        (a, b) =>
          ATTENTION_SEVERITIES.indexOf(a.severity) -
          ATTENTION_SEVERITIES.indexOf(b.severity),
      );

    return { generatedAt: now.toISOString(), signals };
  }
}
