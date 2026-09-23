import { Injectable, Logger } from '@nestjs/common';
import { DomainEvent } from 'src/shared/domain/events/domain-event';
import { jobContextFrom } from 'src/shared/domain/events/job-context';
import { OnDomainEvent } from 'src/shared/infrastructure/events/on-domain-event.decorator';
import { AnalysisScopeService } from 'src/modules/analysis-scope/application/analysis-scope.service';
import { AdScoringDispatcher } from 'src/modules/ad-scoring/infrastructure/queues/ad-scoring.dispatcher';
import { WasteDispatcher } from 'src/modules/waste/infrastructure/queues/waste.dispatcher';
import { RecommendationsDispatcher } from 'src/modules/recommendations/infrastructure/queues/recommendations.dispatcher';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';

/**
 * Atraso entre os degraus da cadeia.
 *
 * A dependência entre eles é resolvida por `JobRun` — `waste` exige `ad-scoring`
 * concluído na mesma janela, e `recommendations` precisa dos achados. Como a
 * fila é assíncrona, não há como aguardar a conclusão de dentro daqui; o atraso
 * dá folga para o degrau anterior terminar.
 *
 * Errar para menos é barato e errar para mais não é: um degrau que chega cedo
 * registra `SKIPPED` com `UPSTREAM_NOT_READY`, e janela pulada **pode ser
 * readquirida** — o cron do dia seguinte a retoma. Só `SUCCEEDED` é definitivo.
 * Por isso a cadeia é otimista: no caminho feliz o usuário vê o diagnóstico em
 * minutos, e no caminho ruim ele volta ao comportamento de antes, sem piorar
 * nada.
 */
const STEP_DELAY_MS = 90_000;

/**
 * A cadeia de inteligência acordada pela **primeira** sincronização da conta.
 *
 * Consumidor de evento puro, como `alerts`: `sync` não pode chamar estes módulos
 * porque os três já importam `SyncModule` pelo lease de `JobRun`, e a chamada na
 * direção oposta fecharia ciclo. Este módulo importa todos e não é importado por
 * ninguém, então a dependência só anda num sentido.
 *
 * Sem ele, conectar uma conta às 14h significava esperar `ads-ingest-full` às
 * 03:20, `analysis-scope` às 05:00, `ad-scoring` às 05:30, `waste` às 06:00 e
 * `recommendations` às 07:00 — o dia inteiro entre a ação do usuário e a
 * primeira resposta do produto.
 */
@Injectable()
export class FirstSyncChainListener {
  private readonly logger = new Logger(FirstSyncChainListener.name);

  constructor(
    private readonly analysisScope: AnalysisScopeService,
    private readonly scoring: AdScoringDispatcher,
    private readonly waste: WasteDispatcher,
    private readonly recommendations: RecommendationsDispatcher,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  @OnDomainEvent('ad_account.first_sync_completed')
  async onFirstSync(
    event: DomainEvent<'ad_account.first_sync_completed'>,
  ): Promise<void> {
    const { adAccountId, organizationId } = event.payload;
    const ctx = jobContextFrom(event);

    /**
     * Só organização com acesso aberto.
     *
     * A varredura diária de quem perdeu acesso também pode ser a primeira de
     * uma conta — conectada horas antes do fechamento — e acordaria scoring,
     * detecção e recomendação para ninguém ver. O cron dos três já não passa
     * por essa organização; a cadeia não pode ser a porta dos fundos.
     */
    const modes = await this.sweep.modesFor([organizationId]);

    if (modes.get(organizationId) !== 'FULL') {
      this.logger.log(
        `onboarding_chain.skipped adAccountId=${adAccountId} ` +
          `organizacao=${organizationId} motivo=acesso`,
      );
      return;
    }

    /**
     * A régua do plano primeiro, e **em processo**.
     *
     * `listScorable` exige `analysisEligibleAt` preenchido; sem este passo o
     * scoring devolveria conjunto vazio em silêncio, que é exatamente o sintoma
     * "os jobs rodaram e as tabelas continuam vazias". É síncrono porque é
     * barato e porque enfileirá-lo reintroduziria a corrida que ele existe para
     * evitar.
     */
    const scope =
      await this.analysisScope.executeForOrganization(organizationId);

    await this.scoring.score({ ctx, adAccountId });
    await this.waste.detect({ ctx, adAccountId }, STEP_DELAY_MS);
    await this.recommendations.generate(
      { ctx, organizationId },
      STEP_DELAY_MS * 2,
    );

    this.logger.log(
      `onboarding_chain.started adAccountId=${adAccountId} ` +
        `organizacao=${organizationId} elegiveis=${scope.eligible}`,
    );
  }
}
