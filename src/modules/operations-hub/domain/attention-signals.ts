import type { PlatformPermission } from 'src/modules/accounts/domain/platform-rbac';

/**
 * O "Requires attention" do Operations Hub — a primeira tela do backoffice
 * depois do login (`docs/workspace-screen.md`).
 *
 * Cada sinal é uma **contagem** de algo que este banco guarda e que espera a
 * mão de um operador. Nenhum deles é métrica de desempenho: "7 chamados sem
 * responsável" pede ação, "tempo médio de resposta" não — e o segundo mora no
 * backend próprio do backoffice (`docs/backoffice-api.md`, C5).
 *
 * ## Um sinal, uma permissão
 *
 * O filtro é pela mesma matriz que autoriza as rotas
 * (`accounts/domain/platform-rbac.ts`). Um sinal cuja permissão o operador não
 * tem **não é contado** — nem com zero: a consulta não roda, e a chave não
 * aparece na resposta. Zero significa "você cuida disto e não há nada";
 * ausência significa "não é da sua área". Misturar os dois faria o painel do
 * financeiro anunciar "0 chamados sem responsável", como se fosse assunto dele.
 *
 * A permissão exigida é sempre a de **leitura** da tela onde o operador
 * resolveria o sinal, com uma exceção deliberada: contrato assinado à espera
 * de ativação pede `orgs:manage`, porque ativar é o único ato que resolve, e
 * só a administração o tem. Mostrá-lo a quem só lê seria anunciar trabalho
 * que a pessoa não pode fazer.
 *
 * ## Por que a resposta carrega a permissão e não a área
 *
 * O agrupamento em áreas (Customer Operations, Support, Billing & Finance…) é
 * navegação, e navegação é do backoffice. Ele já tem o registro canônico onde
 * cada item de menu declara a permissão que exige; basta casar
 * `signal.permission` com o item para saber em que card o contador cai. Se a
 * API devolvesse a área, a mesma decisão viveria em dois repositórios — e
 * mover Contatos de "Support" para "Customer Operations" passaria a exigir
 * deploy do backend.
 */

export const ATTENTION_SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;

export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

export const ATTENTION_SIGNAL_KEYS = [
  'support.tickets_unassigned',
  'support.tickets_high_priority_open',
  'contacts.unread',
  'leads.awaiting_qualification',
  'orgs.contracts_awaiting_activation',
  'billing.invoices_overdue',
  'billing.invoices_failed_recent',
  'billing.contracts_awaiting_first_payment',
  'subscriptions.past_due',
  'subscriptions.trials_ending_soon',
  'integrations.unhealthy',
  'operations.job_runs_stalled',
  'operations.job_runs_failed_recent',
] as const;

export type AttentionSignalKey = (typeof ATTENTION_SIGNAL_KEYS)[number];

export type AttentionSignalDefinition = {
  key: AttentionSignalKey;
  permission: PlatformPermission;
  severity: AttentionSeverity;
};

/**
 * O catálogo. A ordem aqui é a ordem de desempate dentro de uma mesma
 * severidade — e é a ordem em que a tela lista.
 *
 * O que cada chave conta está no leitor Prisma
 * (`infrastructure/database/prisma/attention-counts-prisma.reader.ts`), ao
 * lado da consulta; repetir aqui seria a segunda cópia que diverge.
 */
export const ATTENTION_SIGNALS: readonly AttentionSignalDefinition[] = [
  {
    key: 'operations.job_runs_stalled',
    permission: 'operations:read',
    severity: 'CRITICAL',
  },
  {
    key: 'billing.invoices_overdue',
    permission: 'billing:read',
    severity: 'CRITICAL',
  },
  {
    key: 'support.tickets_high_priority_open',
    permission: 'support:read',
    severity: 'CRITICAL',
  },
  {
    key: 'support.tickets_unassigned',
    permission: 'support:read',
    severity: 'WARNING',
  },
  {
    key: 'integrations.unhealthy',
    permission: 'integrations:read',
    severity: 'WARNING',
  },
  {
    key: 'operations.job_runs_failed_recent',
    permission: 'operations:read',
    severity: 'WARNING',
  },
  {
    key: 'subscriptions.past_due',
    permission: 'subscriptions:read',
    severity: 'WARNING',
  },
  {
    key: 'billing.invoices_failed_recent',
    permission: 'billing:read',
    severity: 'WARNING',
  },
  {
    key: 'orgs.contracts_awaiting_activation',
    permission: 'orgs:manage',
    severity: 'WARNING',
  },
  {
    key: 'billing.contracts_awaiting_first_payment',
    permission: 'billing:read',
    severity: 'INFO',
  },
  {
    key: 'leads.awaiting_qualification',
    permission: 'leads:read',
    severity: 'INFO',
  },
  {
    key: 'contacts.unread',
    permission: 'contacts:read',
    severity: 'INFO',
  },
  {
    key: 'subscriptions.trials_ending_soon',
    permission: 'subscriptions:read',
    severity: 'INFO',
  },
];

/** Os sinais que este conjunto de permissões enxerga, na ordem do catálogo. */
export function signalsVisibleTo(
  permissions: readonly PlatformPermission[],
): AttentionSignalDefinition[] {
  const granted = new Set(permissions);
  return ATTENTION_SIGNALS.filter((signal) => granted.has(signal.permission));
}
