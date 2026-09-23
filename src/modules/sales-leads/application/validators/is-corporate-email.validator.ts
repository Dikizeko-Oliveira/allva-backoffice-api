import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Public email providers that are not accepted as corporate ("work") emails
 * for Enterprise/Growth sales leads.
 */
const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.com.br',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'zoho.com',
  'mail.com',
  'yandex.com',
  'bol.com.br',
  'uol.com.br',
  'terra.com.br',
  'ig.com.br',
]);

@ValidatorConstraint({ name: 'isCorporateEmail', async: false })
export class IsCorporateEmailConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;

    const domain = value.trim().toLowerCase().split('@')[1];
    if (!domain) return false;

    return !FREE_EMAIL_DOMAINS.has(domain);
  }

  defaultMessage(): string {
    return 'A corporate (work) email is required; public email providers are not accepted';
  }
}

export function IsCorporateEmail(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsCorporateEmailConstraint,
    });
  };
}
