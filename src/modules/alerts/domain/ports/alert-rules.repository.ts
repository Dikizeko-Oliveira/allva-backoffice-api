import type { AlertRule } from '../entities';

export abstract class AlertRulesRepositoryInterface {
  abstract save(rule: AlertRule): Promise<void>;
  abstract update(rule: AlertRule): Promise<void>;
  abstract findById(id: string): Promise<AlertRule | null>;
  abstract list(): Promise<AlertRule[]>;
}
