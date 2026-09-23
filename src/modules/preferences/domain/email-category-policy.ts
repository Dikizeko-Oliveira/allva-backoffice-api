/**
 * Email categories the product can send. Preference flags gate the optional
 * ones; TRANSACTIONAL messages (email verification, password reset, invitations,
 * receipts) are never gated — the user cannot opt out of them without losing
 * access to their own account.
 */
export type EmailCategory =
  | 'TRANSACTIONAL'
  | 'DAILY_SUMMARY'
  | 'ALERT'
  | 'PROMOTION'
  | 'PRODUCT_NEWS';

export type EmailPreferenceFlags = {
  notificationByEmail: boolean;
  dailyResume: boolean;
  /**
   * Sprint 6 / M-2. Optional like the others — but note the asymmetry below: an
   * absent preference row withholds ALERT too, because opting someone in to mail
   * they never asked for is worse than a missed alert they can still see in-app.
   */
  alertNotifications: boolean;
  promotionNotifications: boolean;
  productNewsNotification: boolean;
};

/**
 * Single source of truth for "may we send this category to this user?".
 *
 * `notificationByEmail` is the master switch for every optional category, so
 * turning it off silences all of them regardless of the per-category flags.
 * An absent preference row means the account never expressed a choice: optional
 * email is withheld (opt-in), transactional still flows.
 */
export function isEmailCategoryAllowed(
  preference: EmailPreferenceFlags | null | undefined,
  category: EmailCategory,
): boolean {
  if (category === 'TRANSACTIONAL') return true;
  if (!preference) return false;
  if (!preference.notificationByEmail) return false;

  switch (category) {
    case 'DAILY_SUMMARY':
      return preference.dailyResume;
    case 'ALERT':
      return preference.alertNotifications;
    case 'PROMOTION':
      return preference.promotionNotifications;
    case 'PRODUCT_NEWS':
      return preference.productNewsNotification;
    default:
      return false;
  }
}
