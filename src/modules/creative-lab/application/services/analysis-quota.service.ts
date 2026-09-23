import { Injectable } from '@nestjs/common';
import { monthWindow } from 'src/modules/creative-lab/domain/month-window';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/** A linha do catálogo que esta cota governa. */
const FEATURE = 'creative-analyses' as const;

/** O par teto/uso do mês corrente. `limit: null` é "sem teto nesta linha". */
export type AnalysisQuota = { limit: number | null; used: number };

/**
 * A cota mensal de análises de criativo.
 *
 * ## Por que um serviço, e não um método do caso de uso
 *
 * Mesmo desenho de `CopyGenerationService`: a guarda tem duas entradas — a que
 * julga e a que só informa —, resolve teto contra contrato e monta a recusa com
 * data de virada. Isso é regra de negócio com peso próprio, e mantê-la dentro de
 * `AnalyzeAdUseCase` empurrava o caso de uso além do teto de ~150 linhas que
 * §16.6 cobra — o sintoma, não o problema. O problema é que "orquestrar a
 * análise" e "decidir quanto o plano entrega" são duas responsabilidades, e a
 * segunda tem um segundo leitor: o medidor da tela de assinatura.
 *
 * ## O medidor deixou de ser a própria tabela, e por um motivo só
 *
 * `COUNT` sobre `creative_analyses` era barato e não podia discordar de si
 * mesmo — mas não era atômico. Entre contar e inserir cabiam dois cliques, e o
 * mês fechava em 101 de 100. Hoje a reserva é uma instrução só, no contador de
 * `organization_usage_counters`, e o que ela conta é **autorização concedida**:
 * quando o trabalho autorizado não acontece, {@link AnalysisQuotaService.release}
 * devolve a unidade.
 */
@Injectable()
export class AnalysisQuotaService {
  constructor(private readonly planEntitlement: PlanEntitlementService) {}

  /**
   * O par teto/uso, sem consumir — para quem só precisa exibir.
   *
   * É o caminho do reuso de P9: ele devolve a análise guardada sem produzir
   * nada, então não pode cobrar. Recusá-lo no teto tiraria da pessoa uma
   * análise que ela já pagou e que o banco já tem.
   */
  async usage(organizationId: string, now: Date): Promise<AnalysisQuota> {
    const periodStart = monthWindow(now).since;

    const [limit, used] = await Promise.all([
      this.planEntitlement.quotaFor({
        organizationId,
        feature: FEATURE,
      }),
      this.planEntitlement.consumedIn({
        organizationId,
        feature: FEATURE,
        periodStart,
      }),
    ]);

    return { limit, used };
  }

  /**
   * Reserva uma análise — **e a reserva é o que torna o teto exato**.
   *
   * Era `COUNT` e depois `INSERT`, com uma janela entre os dois onde dois
   * cliques simultâneos passavam juntos. `reserveQuota` decide e consome na
   * mesma instrução, então o segundo pedido já enxerga o primeiro.
   *
   * O teto negociado em contrato vence o do plano, como em contas de anúncios e
   * anúncios monitorados — é `PlanEntitlementService` quem resolve os dois, e é
   * o que faz o "sob medida" do Enterprise valer aqui.
   */
  async reserve(organizationId: string, now: Date): Promise<AnalysisQuota> {
    const periodStart = monthWindow(now).since;

    const state = await this.planEntitlement.reserveQuota({
      organizationId,
      feature: FEATURE,
      periodStart,
    });

    if (state.allowed) {
      return { limit: state.limit ?? null, used: state.used ?? 0 };
    }

    const resetsAt = monthWindow(now).until;

    throw new DomainError({
      code: 'CREATIVE_ANALYSIS_QUOTA_EXCEEDED',
      /**
       * `PLAN_LIMITED`, como a cota de copy — e não `RATE_LIMITED`, como o teto
       * diário de IA. A distinção é o que a tela faz com a recusa: o teto diário
       * reabre amanhã sozinho e convida a tentar de novo; a cota do mês só se
       * resolve esperando a virada ou mudando de plano.
       */
      category: 'PLAN_LIMITED',
      message:
        `Você usou as ${state.quota?.limit ?? state.used ?? 0} análises de ` +
        `criativo deste mês no plano ${state.planLabel}.`,
      details: {
        used: state.quota?.used ?? state.used ?? 0,
        limit: state.quota?.limit ?? null,
        resetsAt: resetsAt.toISOString(),
        upgradeTo: state.upgradeTo,
      },
      remediation: state.upgradeTo
        ? `A cota volta em ${resetsAt.toISOString().slice(0, 10)}. ` +
          `O plano ${state.upgradeTo} oferece mais análises por mês.`
        : `A cota volta em ${resetsAt.toISOString().slice(0, 10)}. ` +
          'Para um teto maior, fale com o comercial.',
    });
  }

  /**
   * Devolve a reserva de uma análise que não chegou a existir.
   *
   * É o preço de a cota ser exata: a unidade sai antes do trabalho, então quem
   * conhece o desfecho tem de devolvê-la quando o trabalho não acontece. Sem
   * isto, uma falha ao persistir cobraria do cliente uma análise que ele nunca
   * recebeu — e o contador iria divergindo da tabela sem nada corrigi-lo.
   */
  async release(organizationId: string, now: Date): Promise<void> {
    await this.planEntitlement.releaseQuota({
      organizationId,
      feature: FEATURE,
      periodStart: monthWindow(now).since,
    });
  }
}
