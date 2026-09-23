import type { CopyGenerationContext } from '../schemas/copy-generation.schema';
import type { GeneratedVariant } from '../schemas/copy-generation.schema';
import type { CopyFieldProfile } from 'src/modules/ads/domain/platform/platform-profile';

/**
 * O escritor das variações (§11.4, passo 7).
 *
 * **É a única parte autoral do fluxo, e a fronteira está aqui.** Tudo o que
 * decide *o que* mudar já aconteceu: o score, a comparação entre anúncios e as
 * sugestões chegam prontos no contexto. O que este port produz são as palavras.
 *
 * Declarado em `creative-lab` e implementado sobre o roteamento de `ai`, pelo
 * mesmo motivo de `AnalysisNarrator`: o módulo que sabe **o que** pedir declara
 * o contrato; o que sabe **como** falar o implementa.
 *
 * **Lança quando não consegue.** O contrário — devolver lista vazia — faria a
 * queda do provider e "o modelo não achou o que sugerir" chegarem idênticas a
 * quem chama, e é o serviço de geração que precisa distinguir as duas para
 * gravar `AI_UNAVAILABLE` com o motivo certo.
 */

/** O que a plataforma aceita em cada campo — entra no prompt, não na validação. */
export type CopyFieldBudget = {
  field: 'primaryText' | 'headline' | 'description' | 'callToAction';
  profile: CopyFieldProfile;
};

export type CopyGenerationRequest = {
  organizationId: string;
  adId: string;
  source: 'FROM_INSIGHT' | 'IMPROVE' | 'FROM_BRIEF';
  context: CopyGenerationContext;
  /**
   * Os limites da plataforma, **no prompt**.
   *
   * Validar depois e reescrever seria uma segunda chamada paga para consertar o
   * que a primeira poderia ter acertado. A validação depois continua existindo —
   * o modelo erra —, mas ela é a rede, não o plano.
   */
  fieldBudgets: CopyFieldBudget[];
  /** Quantas variações pedir. Três, por decisão de produto (ver `copy-quota`). */
  variantCount: number;
};

export type GeneratedCopy = {
  variants: GeneratedVariant[];
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Caiu para o provider secundário? O benchmark de custo depende disto. */
  fallbackUsed: boolean;
};

export abstract class CopyGenerator {
  abstract generate(request: CopyGenerationRequest): Promise<GeneratedCopy>;
}
