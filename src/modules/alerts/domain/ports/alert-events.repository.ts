import type {
  PageParams,
  PageResult,
} from 'src/shared/domain/repositories/pagination';
import type { AlertEvent } from '../entities';

export type ListAlertEventsFilter = {
  /** Só eventos cuja regra exige uma destas permissões. */
  permissions: readonly string[];
  acknowledged?: boolean;
};

export abstract class AlertEventsRepositoryInterface {
  abstract findById(id: string): Promise<AlertEvent | null>;
  abstract list(
    filter: ListAlertEventsFilter,
    page: PageParams,
  ): Promise<PageResult<AlertEvent>>;
  abstract saveAcknowledgement(event: AlertEvent): Promise<void>;

  /** Grava um disparo novo (GAP-044). */
  abstract save(event: AlertEvent): Promise<void>;

  /** A regra tem algum disparo ainda não reconhecido? É o que deduplica. */
  abstract hasOpenForRule(ruleId: string): Promise<boolean>;
}
