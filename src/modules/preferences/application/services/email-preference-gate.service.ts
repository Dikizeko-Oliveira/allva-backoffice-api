import { Injectable, Logger } from '@nestjs/common';
import { PreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';
import {
  EmailCategory,
  isEmailCategoryAllowed,
} from 'src/modules/preferences/domain/email-category-policy';

/**
 * Gatekeeper every optional email must pass through, so a preference the user
 * toggled off actually silences the corresponding message. Senders ask this
 * service instead of reading preference flags themselves — that keeps the
 * policy in {@link isEmailCategoryAllowed} rather than scattered across
 * notification code.
 */
@Injectable()
export class EmailPreferenceGate {
  private readonly logger = new Logger(EmailPreferenceGate.name);

  constructor(
    private readonly preferencesRepository: PreferencesRepositoryInterface,
  ) {}

  async canSend(accountId: string, category: EmailCategory): Promise<boolean> {
    // Transactional mail must go out even if the preference row is unreachable,
    // so short-circuit before touching the database.
    if (category === 'TRANSACTIONAL') return true;

    try {
      const preference =
        await this.preferencesRepository.findByAccountId(accountId);
      return isEmailCategoryAllowed(preference, category);
    } catch (error) {
      // Fail closed for optional email: a lookup failure must not turn into
      // mail the user asked not to receive.
      this.logger.warn(
        `preference_gate.lookup_failed accountId=${accountId} category=${category}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
