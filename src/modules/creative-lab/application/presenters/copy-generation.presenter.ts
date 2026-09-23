import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { CopyField } from 'src/modules/ads/domain/platform/platform-profile';
import {
  checkCopyLength,
  copyFieldProfile,
  copyFieldWritability,
} from 'src/modules/ads/domain/platform/platform-profiles';
import type {
  StoredGeneration,
  StoredVariant,
} from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import {
  COPY_ENGINE_VERSION,
  COPY_PROMPT_VERSION,
} from 'src/modules/creative-lab/application/services/copy-generation.service';

/**
 * A resposta da geração, montada num lugar só.
 *
 * Os três caminhos — geração nova, reuso e leitura do histórico — devolvem **o
 * mesmo shape**. Duas montagens divergiriam no primeiro campo acrescentado, e o
 * cliente descobriria pela metade dos casos.
 *
 * ## O campo que não existia em nenhum outro presenter: `applicable`
 *
 * Cada campo de texto viaja com o veredito da plataforma sobre ele. É o que
 * separa **gerado** de **aplicável**, e sem essa separação a tela exibiria um
 * título da Meta com um botão "aplicar" que não tem ação por trás — que é o
 * defeito de F7.7 ao contrário: um campo bonito sem destino.
 *
 * O texto **nunca é reescrito nem cortado aqui**. Um campo que estoura o limite
 * chega inteiro, marcado, com o motivo — a pessoa edita. Aparar em silêncio
 * publicaria um texto que ninguém escreveu.
 */
export function presentGeneration(
  generation: StoredGeneration,
  context: {
    platform: string;
    /** O formato do criativo: no Google, decide qual campo é aplicável. */
    creativeFormat: string | null;
    reused: boolean;
    quota: { limit: number | null; used: number };
    suggestionsWithheld: string | null;
  },
) {
  const platform = context.platform as Platform;

  return envelope(
    {
      generationId: generation.id,
      adId: generation.adId,
      source: generation.source,
      status: generation.status,
      /**
       * O reuso visível, pelo mesmo motivo de `reusedPreviousAnalysis`: sem
       * ele, quem pede duas vezes vê a mesma resposta e conclui que a segunda
       * chamou a IA — e a economia fica indistinguível de um bug.
       */
      reusedPreviousGeneration: context.reused,
      /**
       * `AI_UNAVAILABLE` com `variants: []` **é uma resposta**, não um erro.
       *
       * O contexto e as sugestões que originaram o pedido continuam gravados e
       * visíveis; o que faltou foi o texto. É a formulação de P4 desta feature
       * cumprida na superfície: o determinístico sobrevive à queda da IA.
       */
      aiUnavailable: generation.status === 'AI_UNAVAILABLE',
      variants: generation.variants.map((variant) =>
        presentVariant(variant, platform, context.creativeFormat),
      ),
      suggestionsWithheld: context.suggestionsWithheld,
      /**
       * A cota **na resposta**, e não só na recusa.
       *
       * Descobrir o teto ao bater nele é o pior momento: a tela precisa poder
       * dizer "restam 3 este mês" antes do clique, e não depois do 403.
       */
      quota: {
        limit: context.quota.limit,
        used: context.quota.used,
        remaining:
          context.quota.limit === null
            ? null
            : Math.max(context.quota.limit - context.quota.used, 0),
      },
      createdAt: generation.createdAt.toISOString(),
    },
    {
      asOf: generation.createdAt.toISOString(),
      provenance: {
        engineVersion: generation.engineVersion || COPY_ENGINE_VERSION,
        promptVersion: generation.promptVersion || COPY_PROMPT_VERSION,
        aiProvider: generation.aiProvider,
        aiModel: generation.aiModel,
      },
      /**
       * Uma geração sem variante não sustenta decisão nenhuma, e dizê-lo no
       * envelope é o que impede a tela de tratar a lista vazia como resultado.
       */
      evidenceSufficiency:
        generation.variants.length > 0 ? 'SUFFICIENT' : 'INSUFFICIENT',
    },
  );
}

const FIELD_OF: Record<string, CopyField> = {
  primaryText: 'primaryText',
  headline: 'headline',
  description: 'description',
  callToAction: 'callToAction',
};

function presentVariant(
  variant: StoredVariant,
  platform: Platform,
  creativeFormat: string | null,
) {
  return {
    variantId: variant.id,
    angle: variant.angle,
    /**
     * `hook` sai fora do mapa de campos de propósito: ele **não é campo de
     * plataforma nenhuma**. É a primeira linha do texto principal, e tratá-lo
     * como aplicável faria a tela oferecer aplicar um valor que nenhuma ação
     * sabe onde escrever.
     */
    hook: variant.hook,
    fields: Object.entries(FIELD_OF).map(([key, field]) =>
      presentField(
        field,
        variant[key as keyof StoredVariant] as string | null,
        platform,
        creativeFormat,
      ),
    ),
    reasoning: variant.reasoning,
    selected: variant.selected,
    /** Já foi ao ar? É o vínculo que a medição vai ler. */
    appliedActionExecutionId: variant.appliedActionExecutionId,
    appliedAt: variant.appliedAt?.toISOString() ?? null,
  };
}

function presentField(
  field: CopyField,
  text: string | null,
  platform: Platform,
  creativeFormat: string | null,
) {
  const profile = copyFieldProfile(platform, field);
  const writability = copyFieldWritability(platform, field, creativeFormat);
  const check = text === null ? null : checkCopyLength(platform, field, text);

  return {
    field,
    text,
    length: text?.trim().length ?? 0,
    /**
     * Existe ação que escreve este campo **neste anúncio**? Por formato, não só
     * por plataforma: no Google o CTA é do display, e o título, da busca.
     */
    applicable: writability.writable,
    /** A ação que o aplica — a tela não adivinha qual é. */
    appliedBy: writability.writable ? writability.writableBy : null,
    /**
     * Por que não é aplicável. Vem do perfil, declarado, e não de um "não
     * disponível" que a tela teria de inventar (P7).
     */
    unavailableReason: writability.writable ? null : writability.reason,
    maxLength: profile.maxLength,
    recommendedLength: profile.recommendedLength,
    allowedValues: profile.allowedValues ?? null,
    /**
     * O texto cabe? `null` quando não há texto.
     *
     * Marcado e **não corrigido**: aparar em silêncio publicaria um texto que
     * ninguém escreveu, e a pessoa descobriria a diferença no anúncio no ar.
     */
    fitsPlatform: check === null ? null : check.fits,
    fitReason: check === null || check.fits ? null : check.reason,
  };
}
