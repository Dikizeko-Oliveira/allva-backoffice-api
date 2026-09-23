import { Injectable, NotFoundException } from '@nestjs/common';
import { AdScoreReader } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import { CreativeAnalysisRepositoryInterface } from 'src/modules/creative-lab/domain/ports/creative-analysis.repository';
import { AnalysisQuotaService } from 'src/modules/creative-lab/application/services/analysis-quota.service';
import { AnalysisProductionService } from 'src/modules/creative-lab/application/services/analysis-production.service';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { presentAnalysis } from 'src/modules/creative-lab/application/presenters/creative-analysis.presenter';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * `POST /ads/{id}/analyze` — **a sucessora de `POST /creatives/{id}/optimize`**.
 *
 * A rota antiga saiu em A2-S9 e esta é o que a substitui. Não é renomeação: a
 * unidade de análise mudou de conceito (§3.4). O v1 pontuava o **criativo** e
 * produzia um número por ele; a v2.0 analisa o par **(Creative, Ad)**, porque o
 * mesmo criativo em cinco anúncios tem cinco desempenhos e a média não descreve
 * nenhum — descreve um anúncio que não existe.
 *
 * **Determinística por construção** (P4). Nenhum cliente de IA é injetado aqui:
 * a comparação entre anúncios do mesmo criativo e a resolução de candidatos são
 * funções puras de A2-S4. O enriquecimento por LLM é costura para depois, e com
 * todos os provedores fora do ar esta rota continua produzindo o mesmo
 * diagnóstico.
 *
 * **Rota de `ads`, controller de `creative-lab`** (D3) — o mesmo precedente de
 * `GET /ads/{id}/waste` e `POST /ads/{id}/actions`.
 */
@Injectable()
export class AnalyzeAdUseCase {
  constructor(
    private readonly analyses: CreativeAnalysisRepositoryInterface,
    private readonly scores: AdScoreReader,
    private readonly planEntitlement: PlanEntitlementService,
    private readonly quotas: AnalysisQuotaService,
    private readonly production: AnalysisProductionService,
  ) {}

  async execute(input: { organizationId: string; adId: string }) {
    const startedAt = new Date();

    /**
     * Resolvido aqui porque os **dois** caminhos precisam dele.
     *
     * O reuso de P9 devolve a análise guardada sem passar pelo enriquecimento,
     * então não há `outcome` fresco de onde tirar o motivo - e é justamente no
     * reuso que a pessoa reabre a tela e reencontra a narrativa ausente. Ler o
     * plano vigente responde igual nos dois, e responde sobre o plano de agora:
     * quem acabou de subir para o Profissional para de ver a oferta na hora,
     * sem precisar reanalisar nada.
     */
    const aiReadingIncludedInPlan = await this.planEntitlement.allows({
      organizationId: input.organizationId,
      feature: 'creative-lab',
    });

    const subject = await this.analyses.subjectFor({
      organizationId: input.organizationId,
      adId: input.adId,
    });

    if (!subject) throw new NotFoundException('Anúncio não encontrado');

    /**
     * **Sem score não há análise** (§12.4, P7).
     *
     * A comparação de §11.3 parte dos componentes do score, e o candidato de
     * §11.4 é ranqueado por desempenho medido. Analisar antes do primeiro
     * ciclo de scoring produziria um diagnóstico sobre um anúncio do qual
     * ainda não se sabe nada — e o usuário agiria sobre ele.
     */
    const scoreMap = await this.scores.currentByAdIds(input.organizationId, [
      input.adId,
    ]);
    const score = scoreMap.get(input.adId);

    if (!score) {
      throw new DomainError({
        code: 'AD_NOT_SCORED_YET',
        category: 'INSUFFICIENT_EVIDENCE',
        message:
          'Este anúncio ainda não tem score: não há sobre o que analisar o criativo.',
        details: { adId: input.adId },
        remediation:
          'O ciclo diário de scoring o inclui assim que houver série suficiente.',
      });
    }

    /**
     * **P9 — recomputo sem mudança de entrada é proibido.**
     *
     * O `metricsDigest` combina o score corrente e o `contentHash` do criativo:
     * se nenhum dos dois mudou, a análise de agora produziria exatamente a
     * mesma comparação e os mesmos candidatos. Gravar uma versão nova idêntica
     * inflaria o histórico append-only e faria `version` deixar de significar
     * "o criativo mudou" — que é a única coisa que ela serve para dizer.
     *
     * Sem digest (anúncio sem score), o curto-circuito não se aplica — mas a
     * guarda acima já barrou esse caso antes de chegar aqui.
     */
    const previous = await this.analyses.latestFor({
      organizationId: input.organizationId,
      adId: input.adId,
    });

    if (
      previous &&
      subject.metricsDigest !== null &&
      previous.metricsDigest === subject.metricsDigest
    ) {
      return presentAnalysis(previous, {
        adId: input.adId,
        creativeId: subject.creativeId,
        score,
        reused: true,
        aiReadingIncludedInPlan,
        /**
         * **Medido, não cobrado.** O reuso não escreve linha, então não move o
         * `used` — mas a tela ainda precisa do par para dizer quanto resta, e
         * omiti-lo aqui faria o contador sumir exatamente na chamada que a
         * pessoa mais repete.
         */
        quota: await this.quotas.usage(input.organizationId, startedAt),
      });
    }

    /**
     * **A reserva, e só agora.**
     *
     * Depois do curto-circuito de P9 porque reuso não produz nada: cobrá-lo
     * tiraria da pessoa uma análise que ela já pagou e que o banco já tem.
     * Antes do enriquecimento porque é a última linha em que recusar ainda é
     * barato — passar daqui gasta uma chamada de IA para jogar o resultado
     * fora.
     *
     * **Reserva, e não "verifica"**: a unidade sai do contador aqui, numa
     * instrução atômica. Era `COUNT` e depois `INSERT`, e entre os dois cabiam
     * dois cliques simultâneos — o mês fechava em 101 de 100. O preço de o teto
     * ser exato é o `catch` abaixo: quem reserva antes do trabalho tem de
     * devolver quando o trabalho não acontece.
     */
    const quota = await this.quotas.reserve(input.organizationId, startedAt);

    try {
      return await this.production.produce({
        input,
        subject,
        score,
        startedAt,
        aiReadingIncludedInPlan,
        quota,
      });
    } catch (error) {
      await this.quotas.release(input.organizationId, startedAt);
      throw error;
    }
  }
}
