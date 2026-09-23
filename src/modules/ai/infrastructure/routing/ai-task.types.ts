/**
 * As tarefas de IA **por assunto ads-first** (A2-S4, entrega 12).
 *
 * Os três tipos anteriores — `campaign_analysis`, `ad_title_generation`,
 * `ad_description_generation` — descreviam a campanha ficcional que A2-S1
 * removeu, e ficaram sem nenhum consumidor desde então. Foram substituídos, e
 * não acrescentados: um tipo que ninguém emite é uma promessa que o roteamento
 * não cumpre, e o mesmo achado de vocabulário morto já apareceu na auditoria.
 *
 * O assunto importa porque `activePromptVersions` é um mapa **por tarefa**
 * (D16): narrativa de score, diagnóstico criativo e título de recomendação
 * evoluem em ritmos diferentes, e uma versão global obrigaria a subir as três
 * para mexer numa.
 */
export type AITaskType =
  /** §12.6 — a narrativa que acompanha o AI Score. */
  | 'ad_narrative'
  /** §11.2 — diagnóstico do par `(Creative, Ad)`. */
  | 'creative_diagnosis'
  /** §11.4 — sugestões de hook e corpo para substituição criativa. */
  | 'creative_suggestion'
  /** §9 — título e justificativa legíveis de uma recomendação. */
  | 'recommendation_title'
  /**
   * O resumo diário da organização.
   *
   * Tarefa própria porque `activePromptVersions` é um mapa por tarefa (D16) e
   * esta é a única que fala **da conta inteira**, não de um anúncio: reusar
   * `ad_narrative` faria uma mudança de prompt do score reescrever o resumo, e
   * vice-versa.
   */
  | 'daily_digest';

export type AIProviderType = 'openai' | 'anthropic' | 'memory';

export type ModelCandidate = {
  provider: AIProviderType;
  model: string;
};
