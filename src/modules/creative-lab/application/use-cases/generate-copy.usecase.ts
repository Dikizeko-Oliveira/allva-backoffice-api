import { Injectable, NotFoundException } from '@nestjs/common';
import { CopyContextBuilder } from 'src/modules/creative-lab/application/services/copy-context.builder';
import { CopyGenerationService } from 'src/modules/creative-lab/application/services/copy-generation.service';
import { presentGeneration } from 'src/modules/creative-lab/application/presenters/copy-generation.presenter';
import type { CopyGenerationInputs } from 'src/modules/creative-lab/domain/schemas/copy-generation.schema';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

export type GenerateCopyInput = {
  organizationId: string;
  accountId: string;
  adId: string;
  source: 'FROM_INSIGHT' | 'IMPROVE' | 'FROM_BRIEF';
  inputs: CopyGenerationInputs;
  regenerate: boolean;
  correlationId: string | null;
};

/**
 * `POST /ads/{id}/copy/generations` — a geração de copy do Creative Lab.
 *
 * **Rota de `ads`, controller de `creative-lab`** (D3), o mesmo precedente de
 * `POST /ads/{id}/analyze`: o caminho HTTP pertence ao produto, o controller
 * pertence ao dono do dado.
 *
 * **`adId` obrigatório nas três origens, inclusive em `FROM_BRIEF`.** Uma
 * geração sem anúncio não tem score que justifique o pedido, não tem
 * `REPLACE_COPY` onde aterrissar e não tem linhagem por onde ser medida — e é a
 * única forma da feature que chega perto de originar mídia (P1). "Começar do
 * zero" continua existindo como experiência: é ignorar o texto atual, e a
 * instrução para isso está no prompt.
 */
@Injectable()
export class GenerateCopyUseCase {
  constructor(
    private readonly builder: CopyContextBuilder,
    private readonly generation: CopyGenerationService,
  ) {}

  async execute(input: GenerateCopyInput) {
    const built = await this.builder.build({
      organizationId: input.organizationId,
      adId: input.adId,
      inputs: input.inputs,
    });

    if (!built) throw new NotFoundException('Anúncio não encontrado');

    if (input.source === 'FROM_INSIGHT') {
      this.requireSuggestion(
        built.context.suggestions.length,
        built.suggestionsWithheld,
      );
    }

    const outcome = await this.generation.generate({
      organizationId: input.organizationId,
      accountId: built.subject.accountId,
      adId: input.adId,
      creativeId: built.subject.creativeId,
      analysisId: built.analysisId,
      adScoreId: built.adScoreId,
      source: input.source,
      context: built.context,
      fieldBudgets: built.fieldBudgets,
      regenerate: input.regenerate,
      correlationId: input.correlationId,
    });

    return presentGeneration(outcome.generation, {
      platform: built.subject.platform,
      creativeFormat: built.subject.creativeFormat,
      reused: outcome.reused,
      quota: outcome.quota,
      suggestionsWithheld: built.suggestionsWithheld,
    });
  }

  /**
   * **`FROM_INSIGHT` sem insight é uma recusa, não uma geração vazia.**
   *
   * A origem promete transformar o que a análise achou em texto. Sem sugestão,
   * ela viraria silenciosamente um `FROM_BRIEF` — e a pessoa receberia uma copy
   * apresentada como "a Allva corrigiu o que encontrou" sem que nada tivesse
   * sido encontrado. É a diferença entre a feature e um gerador genérico, e ela
   * se perde exatamente aqui.
   *
   * Os dois motivos de ausência são separados porque pedem ações opostas:
   * **retida** significa que a análise concluiu que o texto não é o remédio, e
   * insistir seria consertar o que não está quebrado; **vazia** significa que
   * não há análise recente, e o caminho é rodá-la.
   */
  private requireSuggestion(count: number, withheld: string | null): void {
    if (count > 0) return;

    throw new DomainError({
      code: withheld ? 'COPY_SUGGESTION_WITHHELD' : 'NO_COPY_SUGGESTION',
      category: 'INSUFFICIENT_EVIDENCE',
      message:
        withheld ??
        'Não há sugestão da análise para transformar em texto neste anúncio.',
      remediation: withheld
        ? 'Se ainda quiser variações, peça uma geração a partir do briefing.'
        : 'Rode a análise do anúncio primeiro: é ela que produz a sugestão.',
    });
  }
}
