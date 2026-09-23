import type { StepResult } from '../archive-guard';

/**
 * `SyncOperation` — a auditoria de **uma execução de sync** (§4.7).
 *
 * Fronteira declarada contra `JobRun` (⊕12): `JobRun` é uma por
 * `(job, escopo, janela)` e conta a unidade de trabalho do job (contas
 * ingeridas); `SyncOperation` é uma por execução de sync — várias por `JobRun` —
 * e conta entidades lidas/escritas **na plataforma**. Painel operacional lê
 * `JobRun`, auditoria de sync lê `SyncOperation`. **Nunca somar os dois.**
 */

export type SyncDirection = 'INBOUND' | 'OUTBOUND';

export type SyncKind =
  | 'FULL_ACCOUNT'
  | 'STRUCTURE_ONLY'
  | 'METRICS_ONLY'
  | 'AD_REFRESH'
  | 'ACTION_WRITE'
  | 'RECONCILIATION'
  | 'REBIND';

export type SyncTrigger =
  | 'SCHEDULE'
  | 'MANUAL'
  | 'WRITE_THROUGH'
  | 'RECONCILE'
  | 'BACKFILL'
  | 'REBIND';

export type SyncOperationStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED';

export type OpenSyncOperationInput = {
  organizationId: string;
  integrationId: string;
  adAccountId?: string | null;
  adId?: string | null;
  direction: SyncDirection;
  kind: SyncKind;
  trigger: SyncTrigger;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  restatementWindowDays?: number | null;
};

export type CloseSyncOperationInput = {
  status: SyncOperationStatus;
  entitiesRead: number;
  entitiesWritten: number;
  driftsDetected?: number;
  /** Só uma resposta completa habilita arquivamento — a correção de §8.2. */
  wasComplete: boolean;
  stepResults: StepResult[];
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type OpenSyncOperation = {
  id: string;
  startedAt: Date;
};

export abstract class SyncOperationsRepositoryInterface {
  abstract open(input: OpenSyncOperationInput): Promise<OpenSyncOperation>;

  /**
   * Checkpoint de paginação persistido **a cada página** (§8.2 passo 4).
   *
   * É o que permite retomar sem reler tudo — e sem ele, uma conta grande que
   * falha na página 40 recomeça do zero na próxima janela, gastando de novo as
   * chamadas que R4 existe para economizar.
   */
  abstract saveCheckpoint(
    syncOperationId: string,
    checkpoints: Record<string, unknown>,
  ): Promise<void>;

  abstract close(
    syncOperationId: string,
    input: CloseSyncOperationInput,
  ): Promise<void>;

  /** Último checkpoint gravado para retomada. */
  abstract lastCheckpoint(input: {
    adAccountId: string;
    kind: SyncKind;
  }): Promise<Record<string, unknown> | null>;
}
