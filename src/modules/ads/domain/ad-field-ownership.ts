/**
 * Propriedade de escrita sobre as colunas de `ads` (§5.4).
 *
 * Seis módulos escrevem em `ads`. Cada grupo de campos tem **um dono**; os
 * demais leem. Sem isso, `observedStatus` e `desiredStatus` acabam escritos pelo
 * mesmo caminho, e a reconciliação passa a reportar drift sobre divergências que
 * o próprio produto criou — corroendo o único sinal que prova ao usuário que a
 * ação foi aplicada.
 *
 * Esta tabela não é documentação: é o dado que `test/architecture/ad-field-ownership.spec.ts`
 * lê para verificar que nenhum módulo escreve campo de outro.
 */
export type AdFieldOwner =
  | 'sync'
  | 'platform-actions'
  | 'ad-scoring'
  | 'waste'
  | 'analysis-scope';

export type AdFieldGroup = {
  owner: AdFieldOwner;
  fields: string[];
  /** Quando o dono escreve. */
  trigger: string;
  /** Como o valor aparece na API. */
  exposedAs: string;
};

export const AD_FIELD_OWNERSHIP: readonly AdFieldGroup[] = [
  {
    /**
     * O dono é um módulo só de escopo, e não `ad-scoring` nem `waste`: os dois
     * **consomem** esta coluna, e pôr a decisão dentro de um deles faria o outro
     * depender do vizinho para saber o que analisar.
     */
    owner: 'analysis-scope',
    /**
     * As duas colunas do escopo, e a segunda é a memória do rodízio.
     *
     * `analysisEligibleAt` responde "está dentro **agora**?" e é zerada toda
     * noite para quem ficou de fora. `analysisLastScopedAt` responde "quando foi
     * a última vez?" e nunca é apagada — sem ela, a faixa de rodízio não teria
     * como ordenar por negligência e viraria sorteio.
     */
    fields: ['analysisEligibleAt', 'analysisLastScopedAt'],
    trigger: 'régua noturna de plano, 05:00 — antes dos dois motores',
    exposedAs: 'adsExcludedByPlanLimit',
  },
  {
    owner: 'sync',
    fields: [
      'observedStatus',
      'observedRawStatus',
      'observedAsOf',
      'lastStructureSyncAt',
      'lastMetricsSyncAt',
      'archivedAt',
    ],
    trigger: 'ingest / refresh',
    exposedAs: 'syncState',
  },
  {
    /**
     * `dataMaturity` é do `sync`, não do `ad-scoring`: ela deriva da janela de
     * atribuição da conta contra a data do dado — é propriedade da observação,
     * não do cálculo. Quem a escrevesse a partir do scoring inverteria a
     * dependência, porque a **detecção precisa dela antes** de decidir se pode
     * rodar (§8.9).
     */
    owner: 'sync',
    fields: ['dataMaturity'],
    trigger: 'ingest',
    exposedAs: 'meta.dataMaturity',
  },
  {
    owner: 'platform-actions',
    fields: ['desiredStatus', 'desiredStatusSetAt'],
    trigger: 'execução de ação',
    exposedAs: 'pendingAction',
  },
  {
    /**
     * Dois donos, uma transição cada: `sync` para todos os estados observados e
     * `platform-actions` **apenas** para `PENDING_WRITE`. A máquina em
     * `ad-sync-state.ts` é quem impõe.
     */
    owner: 'sync',
    fields: ['syncState', 'syncStateAt', 'driftDetails'],
    trigger: 'máquina de estados',
    exposedAs: 'syncState',
  },
  {
    owner: 'ad-scoring',
    fields: [
      'currentScoreId',
      'currentAiScore',
      'currentScoreConfidence',
      'currentScoreCoverage',
      'scoreDelta7d',
      'scoreAsOf',
    ],
    trigger: 'worker diário',
    exposedAs: 'score.asOf',
  },
  {
    owner: 'waste',
    fields: [
      'openWasteCount',
      'openWasteAmount',
      'openWasteCurrency',
      'openWasteAmountBase',
      'avoidableDailyAmountBase',
      'wasteAsOf',
    ],
    trigger: 'worker diário',
    exposedAs: 'waste.asOf',
  },
  {
    owner: 'sync',
    fields: ['lineageId', 'originAdId', 'originActionExecutionId'],
    trigger: 'descoberta (sync) · derivação (platform-actions)',
    exposedAs: 'lineage',
  },
];

/** Todos os campos com dono declarado, achatados. */
export const OWNED_AD_FIELDS: readonly string[] = AD_FIELD_OWNERSHIP.flatMap(
  (group) => group.fields,
);

export function ownerOf(field: string): AdFieldOwner | null {
  return (
    AD_FIELD_OWNERSHIP.find((group) => group.fields.includes(field))?.owner ??
    null
  );
}

/**
 * **Denormalização de leitura nunca é fonte de verdade** (§5.4, regra 2).
 *
 * Divergência entre `openWasteAmountBase` e a agregação de `waste_items` é bug
 * do worker, não empate: a agregação é a verdade e o job diário de reconciliação
 * corrige e alerta (A2-S5). Listar as colunas aqui é o que permite ao teste
 * cobrar que nenhuma leitura de inteligência as trate como origem.
 */
export const DENORMALIZED_READ_FIELDS: readonly string[] = [
  'currentAiScore',
  'currentScoreConfidence',
  'currentScoreCoverage',
  'scoreDelta7d',
  'openWasteCount',
  'openWasteAmount',
  'openWasteAmountBase',
  'avoidableDailyAmountBase',
];
