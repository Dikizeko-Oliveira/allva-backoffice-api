import { isEmailCategoryAllowed } from './email-category-policy';

const allOn = {
  notificationByEmail: true,
  dailyResume: true,
  alertNotifications: true,
  promotionNotifications: true,
  productNewsNotification: true,
};

describe('isEmailCategoryAllowed (M-1 / M-2)', () => {
  it('always allows transactional email, even with every flag off', () => {
    const allOff = {
      notificationByEmail: false,
      dailyResume: false,
      alertNotifications: false,
      promotionNotifications: false,
      productNewsNotification: false,
    };

    expect(isEmailCategoryAllowed(allOff, 'TRANSACTIONAL')).toBe(true);
    expect(isEmailCategoryAllowed(null, 'TRANSACTIONAL')).toBe(true);
  });

  it('silences the matching category when its flag is off', () => {
    expect(
      isEmailCategoryAllowed({ ...allOn, dailyResume: false }, 'DAILY_SUMMARY'),
    ).toBe(false);
    expect(
      isEmailCategoryAllowed(
        { ...allOn, promotionNotifications: false },
        'PROMOTION',
      ),
    ).toBe(false);
    expect(
      isEmailCategoryAllowed(
        { ...allOn, productNewsNotification: false },
        'PRODUCT_NEWS',
      ),
    ).toBe(false);
    // M-2: alerts are gated by their own flag like every other optional category.
    expect(
      isEmailCategoryAllowed({ ...allOn, alertNotifications: false }, 'ALERT'),
    ).toBe(false);
  });

  it('allows a category when its flag is on', () => {
    expect(isEmailCategoryAllowed(allOn, 'DAILY_SUMMARY')).toBe(true);
    expect(isEmailCategoryAllowed(allOn, 'PROMOTION')).toBe(true);
    expect(isEmailCategoryAllowed(allOn, 'PRODUCT_NEWS')).toBe(true);
    expect(isEmailCategoryAllowed(allOn, 'ALERT')).toBe(true);
  });

  it('notificationByEmail is a master switch over every optional category', () => {
    const masterOff = { ...allOn, notificationByEmail: false };

    expect(isEmailCategoryAllowed(masterOff, 'DAILY_SUMMARY')).toBe(false);
    expect(isEmailCategoryAllowed(masterOff, 'PROMOTION')).toBe(false);
    expect(isEmailCategoryAllowed(masterOff, 'PRODUCT_NEWS')).toBe(false);
    // Turning off email entirely must silence alerts too, however urgent.
    expect(isEmailCategoryAllowed(masterOff, 'ALERT')).toBe(false);
  });

  it('withholds optional email when the account has no preference row', () => {
    expect(isEmailCategoryAllowed(null, 'DAILY_SUMMARY')).toBe(false);
    expect(isEmailCategoryAllowed(undefined, 'PROMOTION')).toBe(false);
    expect(isEmailCategoryAllowed(null, 'ALERT')).toBe(false);
  });
});
