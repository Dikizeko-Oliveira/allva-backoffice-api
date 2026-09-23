import { Injectable, NotFoundException } from '@nestjs/common';
import { CopyGenerationsRepositoryInterface } from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import { presentGeneration } from 'src/modules/creative-lab/application/presenters/copy-generation.presenter';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import {
  COPY_ENGINE_VERSION,
  COPY_PROMPT_VERSION,
} from 'src/modules/creative-lab/application/services/copy-generation.service';

/** Quantas gerações o histórico devolve por vez. */
const HISTORY_LIMIT = 20;

/**
 * As leituras do Copy Studio — histórico, detalhe e a escolha da variante.
 *
 * Agrupadas num arquivo porque as três são finas e compartilham o mesmo
 * repositório e o mesmo presenter; é o precedente de `ad-read-use-cases.ts`.
 * Separá-las produziria três classes de dez linhas com o mesmo construtor.
 *
 * **A plataforma é lida do anúncio a cada leitura**, e não gravada na geração.
 * Ela decide o que é aplicável, e um anúncio pode migrar de conta ou a
 * capacidade da plataforma pode mudar: gravar a resposta de ontem faria a tela
 * oferecer aplicar um campo que o gateway já não escreve.
 */
@Injectable()
export class CopyReadUseCases {
  constructor(
    private readonly generations: CopyGenerationsRepositoryInterface,
  ) {}

  /**
   * O histórico do anúncio — **é o que dá sentido a salvar toda geração**.
   *
   * Sem ele, a persistência seria só custo de armazenamento: a variação
   * escolhida, a data e o que veio antes são o material da pergunta que
   * justifica a tabela ("qual sugestão melhorou o desempenho?").
   */
  async listForAd(input: { organizationId: string; adId: string }) {
    const [subject, generations] = await Promise.all([
      this.generations.subjectFor({
        organizationId: input.organizationId,
        adId: input.adId,
      }),
      this.generations.listForAd({
        organizationId: input.organizationId,
        adId: input.adId,
        limit: HISTORY_LIMIT + 1,
      }),
    ]);

    if (!subject) throw new NotFoundException('Anúncio não encontrado');

    const page = generations.slice(0, HISTORY_LIMIT);

    return envelope(
      page.map((generation) => ({
        generationId: generation.id,
        source: generation.source,
        status: generation.status,
        variantCount: generation.variants.length,
        selectedVariantId:
          generation.variants.find((variant) => variant.selected)?.id ?? null,
        /** Já foi ao ar? É o que a medição vai ler quando existir. */
        appliedAt:
          generation.variants
            .map((variant) => variant.appliedAt)
            .find((date) => date !== null)
            ?.toISOString() ?? null,
        aiProvider: generation.aiProvider,
        aiModel: generation.aiModel,
        createdAt: generation.createdAt.toISOString(),
      })),
      {
        asOf: new Date().toISOString(),
        provenance: {
          engineVersion: COPY_ENGINE_VERSION,
          promptVersion: COPY_PROMPT_VERSION,
        },
        page: { hasMore: generations.length > HISTORY_LIMIT },
      },
    );
  }

  async findById(input: { organizationId: string; generationId: string }) {
    const generation = await this.generations.findById(input);

    if (!generation) throw new NotFoundException('Geração não encontrada');

    const subject = await this.generations.subjectFor({
      organizationId: input.organizationId,
      adId: generation.adId,
    });

    return presentGeneration(generation, {
      // Anúncio removido depois da geração: o texto continua legível, e o que
      // se perde é só o veredito de aplicabilidade — que sem anúncio não existe.
      platform: subject?.platform ?? 'META',
      creativeFormat: subject?.creativeFormat ?? null,
      reused: false,
      /**
       * A leitura de uma geração antiga **não recontabiliza a cota**.
       *
       * Contar aqui gastaria uma consulta por abertura de tela para responder
       * uma pergunta que ninguém fez: quem lê o histórico não está pedindo
       * geração nova. A cota vem na resposta de quem gera.
       */
      quota: { limit: null, used: 0 },
      suggestionsWithheld: null,
    });
  }

  /**
   * Marca a variante escolhida.
   *
   * **É o que destrava `REPLACE_COPY` em `recommendations`.** A ação era
   * declarada inviável porque o parâmetro de texto não tinha origem; a variante
   * selecionada passa a ser essa origem, e a seleção é o ato explícito da
   * pessoa que a torna legítima — não a geração, que produz três.
   */
  async select(input: { organizationId: string; variantId: string }) {
    const variant = await this.generations.select(input);

    if (!variant) throw new NotFoundException('Variação não encontrada');

    return envelope(
      {
        variantId: variant.id,
        selected: variant.selected,
        selectedAt: variant.selectedAt?.toISOString() ?? null,
      },
      {
        asOf: new Date().toISOString(),
        provenance: { engineVersion: COPY_ENGINE_VERSION },
      },
    );
  }
}
