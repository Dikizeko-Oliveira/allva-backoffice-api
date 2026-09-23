import { HttpStatus } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { assertRegistrationEnabled } from './assert-registration-enabled';

function envWith(registrationDisabled: boolean): EnvService {
  return {
    get: (key: string) =>
      key === 'REGISTRATION_DISABLED' ? registrationDisabled : undefined,
  } as unknown as EnvService;
}

/**
 * A regra tem três portas, e este arquivo trava o que elas respondem.
 *
 * O que ele não pode garantir é que uma quarta porta lembre de chamar a
 * guarda - foi assim que o cadastro por Google acabou criando a conta por fora
 * do caso de uso de cadastro. O que dá para garantir é que a recusa seja uma
 * só, e que ela não afrouxe sem alguém decidir afrouxar.
 */
describe('assertRegistrationEnabled', () => {
  it('deixa passar quando o cadastro está aberto', () => {
    expect(() => assertRegistrationEnabled(envWith(false))).not.toThrow();
  });

  it('recusa com 403 e sem convite para repetir', () => {
    try {
      assertRegistrationEnabled(envWith(true));
      throw new Error('deveria ter recusado');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);

      const domainError = error as DomainError;
      expect(domainError.code).toBe('REGISTRATION_DISABLED');
      expect(domainError.category).toBe('KILL_SWITCH');
      expect(domainError.httpStatus).toBe(HttpStatus.FORBIDDEN);
      // Insistir não abre o cadastro: o cliente não deve tentar de novo, e a
      // saída é a `remediation`.
      expect(domainError.retryable).toBe(false);
      expect(domainError.remediation).toContain('lista de espera');
    }
  });
});
