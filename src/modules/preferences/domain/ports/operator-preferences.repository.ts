import type { OperatorPreference } from '../entities';

export abstract class OperatorPreferencesRepositoryInterface {
  abstract findByOperatorId(
    operatorId: string,
  ): Promise<OperatorPreference | null>;
  /** Cria na primeira vez, sobrescreve depois. */
  abstract save(preference: OperatorPreference): Promise<void>;
}
