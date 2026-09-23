import { ForbiddenException } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import type { PlatformPermission } from 'src/modules/auth/domain/platform-permissions';

/**
 * A recusa de plataforma, **uma só para o backoffice-api inteiro**, no mesmo
 * formato do `allva-api` (`docs/backoffice-api.md` §1.4, regra 5): a tela lê
 * `details.permission` para dizer ao operador o que faltou.
 *
 * Mora na aplicação, e é chamada **dentro do use case** — não num guard de
 * rota. É o desenho do `allva-api`: a regra acompanha o caso de uso, então um
 * segundo chamador (um job, outra rota) não escapa dela.
 * `test/architecture/authorization.spec.ts` cobra que todo use case a chame.
 *
 * `assertPlatformPermission` recebe o literal tipado — um `'billing:reed'` não
 * compila. Quando a permissão vem de dado (a regra de um alerta, a restrição de
 * uma nota), o use case usa `operator.can(...)` e `platformPermissionDenied`.
 */
export function platformPermissionDenied(
  permission: string,
): ForbiddenException {
  return new ForbiddenException({
    code: 'ACCOUNT_NOT_AUTHORIZED',
    message: `Account not authorized: requires platform permission "${permission}"`,
    details: { permission },
  });
}

export function assertPlatformPermission(
  operator: Operator,
  permission: PlatformPermission,
): void {
  if (operator.can(permission)) return;
  throw platformPermissionDenied(permission);
}
