import { Injectable, Logger } from '@nestjs/common';
import { resolveOrganizationProductAccess } from 'src/modules/subscriptions/access/domain/organization-access';
import { OrganizationSweepRepositoryInterface } from 'src/modules/subscriptions/access/domain/ports/organization-sweep.repository';
import {
  CLOSED_ACCESS_DAILY_SYNC_HOURS,
  SweepMode,
  sweepModeFor,
} from 'src/modules/subscriptions/access/domain/sweep-mode';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/**
 * Decide, por organização, o quanto os jobs a varrem — e é o único lugar que
 * decide.
 *
 * ## Por que um serviço, e não um filtro em cada repositório de alvo
 *
 * Os schedulers escolhiam alvos cada um com a própria consulta, e nenhuma olhava
 * se a organização ainda tinha acesso: organização excluída e assinatura vencida
 * seguiam com ingest de hora em hora, scoring, detecção e resumo com IA. A regra
 * de acesso é a do resolver, e repeti-la em SQL em cada repositório é como a
 * tolerância do contrato passaria a valer em uns jobs e não em outros.
 *
 * ## O carimbo
 *
 * Nada no banco diz **quando** o acesso fechou — o teste expira por data, o
 * contrato fecha pela tolerância calculada na leitura, a Stripe muda o status
 * sem carimbo. Então a primeira varredura que observa o fechamento carimba
 * `access_closed_at`, e a janela de sync diário conta dali. A observação nunca
 * é anterior ao fechamento, então a janela real nunca é menor que as 48h.
 */
@Injectable()
export class OrganizationSweepPolicyService {
  private readonly logger = new Logger(OrganizationSweepPolicyService.name);

  constructor(
    private readonly repository: OrganizationSweepRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async modesFor(
    organizationIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, SweepMode>> {
    const ids = [...new Set(organizationIds)];
    const modes = new Map<string, SweepMode>();

    if (ids.length === 0) return modes;

    const snapshots = await this.repository.findSnapshots(ids, now);
    const orgScopedEntitlement = this.env.get('ORG_SCOPED_ENTITLEMENT');
    const toMark: string[] = [];
    const toClear: string[] = [];

    for (const snapshot of snapshots) {
      const deleted = snapshot.deletedAt !== null;
      const access = resolveOrganizationProductAccess({
        orgScopedEntitlement,
        subscription: snapshot.subscription,
        accounts: snapshot.accounts,
        now,
      });
      const mode = sweepModeFor({
        deleted,
        access,
        accessClosedAt: snapshot.accessClosedAt,
        now,
      });

      modes.set(snapshot.organizationId, mode);

      // Excluída não abre nem fecha janela: não há volta a esperar.
      if (deleted) continue;

      if (mode === 'FULL') {
        if (snapshot.accessClosedAt) toClear.push(snapshot.organizationId);
      } else if (!snapshot.accessClosedAt) {
        toMark.push(snapshot.organizationId);
      }
    }

    // Organização que sumiu entre a listagem e aqui não é varrida.
    for (const id of ids) {
      if (!modes.has(id)) modes.set(id, 'NONE');
    }

    if (toMark.length > 0) {
      await this.repository.markAccessClosed(toMark, now);
      this.logger.log(
        `sweep.access_closed organizacoes=${toMark.length} ` +
          `sync_diario_por=${CLOSED_ACCESS_DAILY_SYNC_HOURS}h`,
      );
    }

    if (toClear.length > 0) {
      await this.repository.clearAccessClosed(toClear);
      this.logger.log(`sweep.access_reopened organizacoes=${toClear.length}`);
    }

    return modes;
  }

  /** Filtra itens pela organização de cada um, mantendo só os modos aceitos. */
  async keepByMode<T>(
    items: readonly T[],
    organizationOf: (item: T) => string,
    accepted: readonly SweepMode[],
    now: Date = new Date(),
  ): Promise<{ kept: T[]; skipped: number }> {
    const modes = await this.modesFor(items.map(organizationOf), now);
    const kept = items.filter((item) =>
      accepted.includes(modes.get(organizationOf(item)) ?? 'NONE'),
    );

    return { kept, skipped: items.length - kept.length };
  }
}
