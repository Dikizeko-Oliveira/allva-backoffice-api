import { Injectable } from '@nestjs/common';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DailyDigestRepositoryInterface } from 'src/modules/analytics/domain/ports/daily-digest.repository';

/**
 * `GET /analytics/daily-digest` — **só lê**.
 *
 * Esta rota nunca aciona a IA, e é essa a decisão de desenho: um resumo gerado
 * na leitura entraria em ação a cada refresh, a cada aba aberta, a cada
 * navegação de volta ao Dashboard. O texto é produzido uma vez por dia pelo
 * agendador; aqui só se lê o que já existe.
 *
 * Sem resumo do dia, `data` vem `null` — e a tela diz que ainda não há, como
 * qualquer seção de §7.5. Gerar sob demanda "só desta vez" é como o gancho
 * volta.
 */
@Injectable()
export class GetDailyDigestUseCase {
  constructor(
    private readonly digests: DailyDigestRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string) {
    const owner = await this.scope.resolveForAccount(accountId);

    // `provenance` vazio, e não ausente: a rota é de inteligência e o
    // interceptor cobra os dois campos de P7 também quando `data` é `null` —
    // sem ele, "ainda não há resumo" virava 500 fora de produção.
    if (!owner.organizationId) {
      return envelope(null, { asOf: new Date().toISOString(), provenance: {} });
    }

    const digest = await this.digests.latestFor(owner.organizationId);

    if (!digest) {
      return envelope(null, { asOf: new Date().toISOString(), provenance: {} });
    }

    return envelope(
      {
        digestDate: digest.digestDate.toISOString().slice(0, 10),
        facts: digest.facts,
        narrative: digest.narrative,
        enrichedByAI: digest.enrichedByAI,
        /** Aponta o dia de origem quando o texto foi reaproveitado (P9). */
        reusedFromDate: digest.reusedFromDate
          ? digest.reusedFromDate.toISOString().slice(0, 10)
          : null,
      },
      {
        // `asOf` é o dia do resumo, não o instante da resposta: o texto pode ser
        // de ontem, e a tela precisa poder dizer isso.
        asOf: digest.digestDate.toISOString(),
        provenance: digest.promptVersion
          ? { engineVersion: digest.promptVersion }
          : {},
      },
    );
  }
}
