import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthenticateOperatorUseCase } from './application/use-cases';
import { OperatorIdentityGatewayInterface } from './domain/ports';
import { OperatorAuthGuard } from './infrastructure/http/guards/operator-auth.guard';
import { AllvaApiOperatorIdentityGateway } from './infrastructure/providers/allva-api-operator-identity.gateway';

/**
 * Identidade do operador. O backoffice-api não emite token nem guarda senha:
 * o login é no `allva-api`, e aqui só se pergunta a ele quem é o dono do
 * bearer (`docs/backoffice-api.md` §2).
 */
@Module({
  providers: [
    AuthenticateOperatorUseCase,
    {
      provide: OperatorIdentityGatewayInterface,
      useClass: AllvaApiOperatorIdentityGateway,
    },
    { provide: APP_GUARD, useClass: OperatorAuthGuard },
  ],
})
export class AuthModule {}
