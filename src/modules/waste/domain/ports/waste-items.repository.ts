import type { EvidenceSufficiency } from 'src/shared/domain/provenance';
import type { EvidenceGap } from '../evidence-gaps';
import type { DataMaturity } from 'src/modules/sync/domain/data-maturity';
import type {
  FindingKind,
  FindingType,
  ScopeLevel,
  WastePriority,
  WasteResolutionKind,
} from '../contracts/finding-catalog';
import type { WasteEvidence } from '../schemas/waste-evidence.schema';

/**
 * O lado de **escrita** de `waste_items` (§10.7 passos 6 a 8).
 *
 * `status` não aparece em lugar nenhum deste contrato, e a ausência é a decisão
 * D10: `WasteStatus` foi reduzido a `{OPEN, RESOLVED}` e um `CHECK` no banco
 * amarra `status = 'OPEN'` a `resolved_at IS NULL`. Quem escreve declara **a
 * resolução**; o status é consequência, e mantê-lo como entrada independente é
 * exatamente como a view `open_waste` e a listagem divergiam.
 */

export type WasteItemWrite = {
  adId: string;
  organizationId: string;
  accountId: string;
  creativeId: string | null;

  findingKind: FindingKind;
  type: FindingType;
  priority: WastePriority;
  windowDays: number;

  /** As duas grandezas, nas duas moedas (§10.1, R-M). */
  incurredAmount: number;
  incurredAmountBase: number;
  avoidableDailyAmount: number;
  avoidableDailyBase: number;
  currency: string;
  baseCurrency: string;

  diagnosis: string;
  evidence: WasteEvidence;
  evidenceSufficiency: EvidenceSufficiency;
  scopeLevel: ScopeLevel;
  dataMaturity: DataMaturity | null;
  detectorVersion: string;
  detectorProfileVersion: string;

  /** `sha256(adId|type)` — sem versão e sem janela (§10.7 passo 6). */
  fingerprint: string;
};

/** Um item aberto, na forma mínima que o auto-resolve precisa. */
export type OpenWasteItem = {
  id: string;
  adId: string;
  type: FindingType;
  fingerprint: string;
  detectorVersion: string;
  occurrences: number;
  lastSeenAt: Date;
  windowDays: number;
  /**
   * `evidence.observed` de quando o item foi gravado.
   *
   * É o que permite distinguir `RESOLVED_BY_RESTATEMENT` de
   * `RESOLVED_EXTERNALLY` (§10.9): sem os valores de então, "o achado sumiu" é
   * indistinguível de "o passado foi reescrito", e o dataset de P8 nasce com os
   * falsos positivos contados como acertos.
   */
  observed: Record<string, number> | null;
};

export type WasteUpsertResult = {
  fingerprint: string;
  id: string;
  created: boolean;
};

export type WasteResolutionWrite = {
  id: string;
  kind: WasteResolutionKind;
  resolvedAt: Date;
  resolvedByAccountId?: string | null;
  resolvedByActionExecutionId?: string | null;
};

/** O que as colunas denormalizadas de `ads` recebem (§5.4, grupo do `waste`). */
export type AdWasteDenormalization = {
  adId: string;
  openWasteCount: number;
  openWasteAmount: number;
  openWasteAmountBase: number;
  openWasteCurrency: string | null;
  avoidableDailyAmountBase: number;
  wasteAsOf: Date;
  /**
   * O que não pôde ser julgado neste anúncio, e quando deve poder
   * (`evidence-gaps.ts`). `null` para anúncio que não entrega: não há o que
   * esperar de quem está pausado. **Ausente preserva o gravado** — a
   * reconciliação de denormalizações corrige os totais de desperdício e não
   * tem o que dizer sobre evidência.
   */
  evidenceGaps?: EvidenceGap[] | null;
};

export abstract class WasteItemsRepositoryInterface {
  abstract openItemsFor(input: {
    organizationId: string;
    adIds: string[];
  }): Promise<OpenWasteItem[]>;

  /**
   * Upsert por fingerprint (§10.7 passo 6).
   *
   * `occurrences` incrementa **somente** quando `lastSeenAt` é de janela
   * anterior. Sem essa condição, uma reexecução do mesmo dia — retry de fila,
   * cron sobrepondo a cadeia por evento — infla o contador, e `occurrences` é
   * sinal usado por P8 para medir persistência do problema.
   */
  abstract upsertMany(
    writes: WasteItemWrite[],
    now: Date,
  ): Promise<WasteUpsertResult[]>;

  abstract resolveMany(resolutions: WasteResolutionWrite[]): Promise<number>;

  /**
   * Marca itens cujo anúncio ficou sem observação válida.
   *
   * O item continua **aberto** e declarado velho. É a outra metade de "ausência
   * de dado nunca é evidência": não resolver não basta se a tela continuar
   * apresentando o número como se fosse de hoje.
   */
  abstract markStaleObservation(input: {
    ids: string[];
    stale: boolean;
  }): Promise<number>;

  abstract denormalizeIntoAds(updates: AdWasteDenormalization[]): Promise<void>;

  /** Resolução manual (§10.9) — devolve `null` quando o item não é da org. */
  abstract resolveOne(input: {
    id: string;
    organizationId: string;
    kind: Extract<WasteResolutionKind, 'RESOLVED_EXTERNALLY' | 'DISMISSED'>;
    reason: string;
    resolvedByAccountId: string;
    now: Date;
  }): Promise<{ id: string; adId: string; kind: WasteResolutionKind } | null>;

  /**
   * Resolução manual **por anúncio** (§10.9, linha "por anúncio").
   *
   * `types` ausente resolve todos os abertos. Devolve os itens efetivamente
   * resolvidos — e só eles: quem já estava resolvido não volta na lista, senão
   * a rota emitiria `waste.resolved` por item que ninguém acabou de fechar.
   */
  abstract resolveForAd(input: {
    adId: string;
    organizationId: string;
    types?: FindingType[];
    kind: Extract<WasteResolutionKind, 'RESOLVED_EXTERNALLY' | 'DISMISSED'>;
    reason: string;
    resolvedByAccountId: string;
    now: Date;
  }): Promise<Array<{ id: string; type: FindingType }>>;

  /**
   * Recalcula as colunas de `ads` **a partir da view**, para os anúncios dados.
   *
   * Existe para a resolução manual: sem ela, fechar os achados de um anúncio o
   * deixaria com `openWasteCount` antigo até o ciclo da madrugada — um dia
   * inteiro de dinheiro queimando na tela de um anúncio já resolvido. Aplica a
   * mesma regra de §10.6 que o worker aplica, no mesmo lugar: `MAX` sobre
   * `open_waste`, nunca soma.
   */
  abstract recomputeDenormalization(adIds: string[], now: Date): Promise<void>;
}
