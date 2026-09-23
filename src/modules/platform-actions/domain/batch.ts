import type { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import { carriesAuthoredContent } from 'src/modules/platform-actions/domain/authored-content';
import type { ValidationDepth } from 'src/modules/platform-actions/domain/contracts/action-contracts';
import type { DomainErrorCategory } from 'src/shared/domain/error-category';

/**
 * §13.5 / entrega 6 — **as regras do lote, antes de qualquer item ser tocado.**
 *
 * Um lote é a ferramenta que transforma "pausar os doze piores" de doze cliques
 * em um. É também a que transforma um engano de doze anúncios num engano de
 * cem, e é por isso que ele tem regras próprias em vez de ser um laço sobre a
 * escrita individual.
 */

/** §13.5 — o teto de blast radius. Cem é o limite declarado. */
export const MAX_BATCH_SIZE = 100;

/**
 * Acima de dez itens, o dry-run precisa chegar à plataforma.
 *
 * A validação local pega parâmetro faltante e moeda errada. Só a da plataforma
 * pega "este conjunto está sob CBO", "este anúncio está em revisão", "este
 * criativo foi removido" — e um dry-run local que aprova cem anúncios aprova
 * exatamente as operações que a plataforma vai recusar. Abaixo de dez, o
 * usuário consegue conferir item a item; acima, ele confia no relatório.
 */
export const PLATFORM_VALIDATION_THRESHOLD = 10;

export type BatchRefusal = {
  code: string;
  category: DomainErrorCategory;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

export type BatchGuardInput = {
  items: Array<{ adId: string; type: AdActionType }>;
  validationDepth: ValidationDepth | undefined;
};

/**
 * As recusas que valem para o **lote inteiro**, avaliadas antes de qualquer
 * item.
 *
 * Distintas das recusas por item de propósito: um lote com tamanho inválido
 * nunca deveria ter começado, e recusá-lo item a item produziria cem linhas
 * dizendo a mesma coisa sobre um pedido que era inválido como um todo.
 */
export function checkBatch(input: BatchGuardInput): BatchRefusal | null {
  if (input.items.length === 0) {
    return {
      code: 'BATCH_EMPTY',
      category: 'VALIDATION',
      message: 'Um lote precisa de pelo menos um item.',
    };
  }

  if (input.items.length > MAX_BATCH_SIZE) {
    return {
      code: 'BATCH_TOO_LARGE',
      category: 'VALIDATION',
      message: `Um lote aceita no máximo ${MAX_BATCH_SIZE} itens, e este traz ${input.items.length}.`,
      remediation: 'Divida o pedido em lotes menores.',
      details: { limit: MAX_BATCH_SIZE, received: input.items.length },
    };
  }

  /**
   * R14 — **conteúdo autoral nunca em lote.** Confirmar cem textos num clique é
   * não confirmar nenhum, e o texto vai ao ar sob a marca do cliente. A guarda
   * existe desde A2-S7 no caminho individual; aqui ela ganha o caminho que a
   * exercita.
   */
  const authored = input.items.filter((item) =>
    carriesAuthoredContent(item.type),
  );

  if (authored.length > 0) {
    return {
      code: 'AI_CONTENT_NOT_ALLOWED_IN_BATCH',
      category: 'VALIDATION',
      message:
        'Conteúdo autoral não pode ser aplicado em lote: cada texto é confirmado individualmente.',
      remediation: 'Envie uma ação por anúncio, com o texto confirmado.',
      details: { types: [...new Set(authored.map((item) => item.type))] },
    };
  }

  if (
    input.items.length > PLATFORM_VALIDATION_THRESHOLD &&
    input.validationDepth !== 'PLATFORM'
  ) {
    return {
      code: 'PLATFORM_VALIDATION_REQUIRED',
      category: 'VALIDATION',
      message: `Acima de ${PLATFORM_VALIDATION_THRESHOLD} itens o dry-run precisa de validationDepth=PLATFORM.`,
      remediation:
        'Reenvie com validationDepth=PLATFORM: só a plataforma sabe dizer o que ela vai recusar.',
      details: {
        threshold: PLATFORM_VALIDATION_THRESHOLD,
        received: input.items.length,
      },
    };
  }

  /**
   * **O mesmo anúncio duas vezes no mesmo lote é um pedido contraditório.**
   *
   * I2 já impediria a segunda escrita — o índice parcial recusa duas execuções
   * em voo no mesmo alvo —, mas ela chegaria como conflito no meio do
   * processamento, depois de a primeira já ter sido enviada. Recusar aqui diz
   * ao usuário o que está errado com o pedido dele, em vez de reportar uma
   * corrida que ele mesmo criou.
   */
  const seen = new Set<string>();
  const duplicated = input.items.find((item) => {
    const key = `${item.adId}:${item.type}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });

  if (duplicated) {
    return {
      code: 'BATCH_DUPLICATE_ITEM',
      category: 'VALIDATION',
      message: `O lote repete ${duplicated.type} sobre o mesmo anúncio.`,
      remediation: 'Deixe uma ocorrência de cada ação por anúncio.',
      details: { adId: duplicated.adId, type: duplicated.type },
    };
  }

  return null;
}

export type BatchItemOutcome =
  | { status: 'ACCEPTED'; executionId: string }
  | { status: 'REFUSED'; code: string; message: string };

export type BatchReport = {
  batchId: string;
  total: number;
  accepted: number;
  refused: number;
  items: Array<{ adId: string; type: AdActionType } & BatchItemOutcome>;
};

/**
 * §13.5 — **a recusa de um item não aborta o lote.**
 *
 * O usuário pediu doze pausas; se duas forem recusadas porque os anúncios já
 * estavam pausados, as outras dez devem acontecer. Abortar tudo devolveria a
 * ele o trabalho de descobrir quais passariam — que é exatamente o trabalho que
 * o lote existe para tirar dele.
 */
export function summarize(
  items: Array<{ adId: string; type: AdActionType } & BatchItemOutcome>,
  batchId: string,
): BatchReport {
  return {
    batchId,
    total: items.length,
    accepted: items.filter((item) => item.status === 'ACCEPTED').length,
    refused: items.filter((item) => item.status === 'REFUSED').length,
    items,
  };
}
