import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertCustomerAccount } from 'src/modules/accounts/application/platform-authorization';
import { AccessStatus } from 'src/modules/subscriptions/access/domain/access-status';
import { resolveDefaultRedirect } from 'src/modules/subscriptions/access/domain/redirect-paths';
import {
  SubscriptionContextResolver,
  SubscriptionContext,
} from 'src/modules/subscriptions/access/application/subscription-context.resolver';
import { ACCESS_STATUSES_METADATA } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { AUTHENTICATED_ONLY_METADATA } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';
import { ALLOW_FREE_TRIAL_METADATA } from 'src/modules/subscriptions/access/infrastructure/http/decorators/allow-free-trial.decorator';

type AuthenticatedRequest = {
  user?: {
    id: string;
    email: string;
    sessionId: string;
    role?: string | null;
  } | null;
  // Set by OrganizationContextMiddleware when a valid X-Organization-Id is sent.
  organizationContext?: { organizationId?: string } | null;
  __subscriptionContext?: SubscriptionContext;
};

@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: SubscriptionContextResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(
      AUTHENTICATED_ONLY_METADATA,
      [context.getHandler(), context.getClass()],
    );

    const requiredStatuses = this.reflector.getAllAndOverride<AccessStatus[]>(
      ACCESS_STATUSES_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (authenticatedOnly || !requiredStatuses?.length) {
      return true;
    }

    /**
     * Daqui para baixo é o **produto do cliente** — rota que pede estado de
     * assinatura. Conta de plataforma não entra, com ou sem assinatura.
     *
     * O corte fica no guard, e não em cada use case, porque é ele que já
     * separa as duas famílias de rota: `@AuthenticatedOnly` é a conta (perfil,
     * preferências, senha — que o backoffice também usa), `@RequireAccessStatuses`
     * é o produto (organização, assinatura, checkout, integração, anúncio).
     *
     * E vem **antes** da resolução de assinatura de propósito: sem ele o
     * operador recebia `BLOCKED` com `redirectTo` para o checkout, e o front
     * o mandava assinar.
     */
    assertCustomerAccount({ role: request.user.role });

    const subscriptionContext =
      request.__subscriptionContext ??
      (await this.resolver.resolve(request.user.id, {
        organizationId: request.organizationContext?.organizationId ?? null,
      }));

    request.__subscriptionContext = subscriptionContext;

    if (requiredStatuses.includes(subscriptionContext.accessStatus)) {
      return true;
    }

    // O teste gratuito é `ALLOWED` como uma assinatura paga, e as portas de
    // contratação precisam distinguir os dois: quem está testando é justamente
    // quem ainda vai assinar. Só passa onde a rota pediu — veja `@AllowFreeTrial`.
    const allowsFreeTrial = this.reflector.getAllAndOverride<boolean>(
      ALLOW_FREE_TRIAL_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (allowsFreeTrial && subscriptionContext.onFreeTrial) {
      return true;
    }

    throw this.buildForbiddenException(subscriptionContext);
  }

  private buildForbiddenException(ctx: SubscriptionContext) {
    const payload = {
      code: this.mapErrorCode(ctx.accessStatus),
      message: this.mapErrorMessage(ctx.accessStatus),
      accessStatus: ctx.accessStatus,
      billingStatus: ctx.billingStatus,
      redirectTo: ctx.redirectPath ?? resolveDefaultRedirect(ctx.accessStatus),
    };

    if (ctx.accessStatus === 'ALLOWED') {
      return new ConflictException({
        ...payload,
        code: 'INVALID_SUBSCRIPTION_STATE',
      });
    }

    return new ForbiddenException(payload);
  }

  private mapErrorCode(status: AccessStatus): string {
    switch (status) {
      case 'PENDING_ACTIVATION':
        return 'SUBSCRIPTION_PENDING_ACTIVATION';
      case 'PAYMENT_REQUIRED':
      case 'BLOCKED':
        return 'SUBSCRIPTION_REQUIRED';
      case 'GRACE_PERIOD':
        return 'SUBSCRIPTION_REQUIRED';
      case 'ALLOWED':
        return 'INVALID_SUBSCRIPTION_STATE';
      default:
        return 'SUBSCRIPTION_REQUIRED';
    }
  }

  private mapErrorMessage(status: AccessStatus): string {
    switch (status) {
      case 'PENDING_ACTIVATION':
        return 'Subscription is pending activation';
      case 'PAYMENT_REQUIRED':
        return 'Subscription payment is required';
      case 'BLOCKED':
        return 'Subscription required to access this resource';
      case 'GRACE_PERIOD':
        return 'Action not allowed during grace period';
      case 'ALLOWED':
        return 'Subscription state does not allow this action';
      default:
        return 'Subscription required to access this resource';
    }
  }
}
