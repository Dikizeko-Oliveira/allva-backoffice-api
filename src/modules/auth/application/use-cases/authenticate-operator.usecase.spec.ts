import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Operator } from 'src/modules/auth/domain/entities';
import {
  OperatorIdentityGatewayInterface,
  OperatorIdentityResult,
} from 'src/modules/auth/domain/ports';
import { AuthenticateOperatorUseCase } from './authenticate-operator.usecase';

function build(result: OperatorIdentityResult) {
  const gateway: OperatorIdentityGatewayInterface = {
    introspect: jest.fn().mockResolvedValue(result),
  };
  return new AuthenticateOperatorUseCase(gateway);
}

describe('AuthenticateOperatorUseCase', () => {
  it('devolve o operador identificado', async () => {
    const operator = Operator.restore({
      id: 'op-1',
      name: 'Ana',
      email: 'ana@allva.com',
      platformRole: 'ALLVA_SUPPORT',
      permissions: ['support:read'],
      accessToken: 'token',
    });

    await expect(
      build({ status: 'OPERATOR', operator }).execute('token'),
    ).resolves.toBe(operator);
  });

  it('conta de cliente recebe 403, não 401', async () => {
    await expect(
      build({ status: 'NOT_OPERATOR' }).execute('token'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('token recusado pelo allva-api é 401', async () => {
    await expect(
      build({ status: 'UNAUTHENTICATED' }).execute('token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allva-api fora é 503 — fecha na dúvida, sem deslogar o operador', async () => {
    await expect(
      build({ status: 'UNAVAILABLE' }).execute('token'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
