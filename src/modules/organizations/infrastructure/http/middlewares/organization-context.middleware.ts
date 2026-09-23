import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import {
  OrganizationContext,
  OrganizationContextResolver,
} from 'src/modules/organizations/application/organization-context.resolver';
import {
  WorkspaceContext,
  organizationWorkspace,
  noOrganizationWorkspace,
} from 'src/modules/organizations/application/workspace-context';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';
import { runInTenant } from 'src/shared/infrastructure/database/prisma/tenant-scope';

export type RequestWithOrganization = Request & {
  user?: { id: string; email?: string; sessionId?: string } | null;
  organizationContext?: OrganizationContext;
  workspaceContext?: WorkspaceContext;
};

const ORGANIZATION_HEADER = 'x-organization-id';

@Injectable()
export class OrganizationContextMiddleware implements NestMiddleware {
  constructor(
    private readonly resolver: OrganizationContextResolver,
    private readonly requestContext: RequestContextService,
  ) {}

  async use(req: RequestWithOrganization, _: Response, next: NextFunction) {
    const headerValue = req.headers[ORGANIZATION_HEADER];
    const organizationId = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;

    // No authenticated user yet (e.g. public route) -> no workspace to resolve.
    if (!req.user?.id) {
      return this.requestContext.runMerging({}, () => next());
    }

    /**
     * Sem header, a requisição corre na organização **padrão** da conta.
     *
     * Era PERSONAL aqui, e essa era a terceira resposta para "onde estou": tanto
     * `CurrentOrganizationResolver.resolveDefault` quanto
     * `OwnerScopeResolverService.resolveDefaultScope` já caíam na organização
     * padrão quando o header faltava. O middleware discordava dos dois, e era a
     * resposta dele que alimentava `GET /auth/me` — a rota que o próprio
     * controller declara ser a fonte de verdade de autorização do frontend.
     *
     * O sintoma era a tela de organização em skeleton eterno: `GET
     * /organizations` respondia 200 (usa o resolvedor que acerta) e o cliente
     * recebia `permissions` com o conjunto pessoal, sem nenhuma permissão de
     * organização para renderizar o que tinha em mãos.
     *
     * A procedência não muda: o `organizationId` continua vindo de uma
     * participação ativa do usuário autenticado, resolvida no servidor. O que
     * muda é que a ausência do header deixou de significar "nenhuma
     * organização" e passou a significar "a de sempre" — que é o que
     * organization-first quer dizer.
     */
    if (!organizationId) {
      const defaultContext = await this.resolver.resolveDefault(req.user.id);

      /**
       * Conta que não alcança organização nenhuma segue adiante sem contexto de
       * organização — e **precisa** seguir.
       *
       * É desta requisição sem header que depende o resgate do gateway: quando
       * o cookie de organização aponta para uma inacessível, o middleware
       * responde 403 em toda rota, e a única saída é limpar o cookie e repetir
       * sem ele. Recusar aqui trocaria "sem organização" por "aplicação
       * inteira travada, sem caminho de volta".
       *
       * O estado deixou de nascer assim — o cadastro provisiona —, mas continua
       * alcançável: o provisionamento é best-effort de propósito, para que uma
       * falha nele nunca custe a conta ao usuário. `onboarding.nextStep` no
       * `/auth/me` diz o que fazer a respeito.
       */
      if (!defaultContext) {
        req.workspaceContext = noOrganizationWorkspace(req.user.id);
        return this.requestContext.runMerging({}, () => next());
      }

      req.organizationContext = defaultContext;
      req.workspaceContext = organizationWorkspace(defaultContext);

      return this.requestContext.runMerging(
        { organizationId: defaultContext.organizationId },
        () => runInTenant(defaultContext.organizationId, () => next()),
      );
    }

    // When the header IS provided it must reference an org the user can access;
    // an invalid value surfaces as 403 rather than being silently ignored.
    const organizationContext = await this.resolver.resolve(
      req.user.id,
      organizationId,
    );
    req.organizationContext = organizationContext;
    req.workspaceContext = organizationWorkspace(organizationContext);

    // Publish the selected org into the per-request context so scope resolvers
    // deep in the call chain honor X-Organization-Id without threading it
    // through every use case (A-6).
    //
    // **E no escopo de tenant do banco** (R9, A2-S9): é ele que a extensão do
    // Prisma lê para publicar `app.organization_id` ao Postgres, e é contra ele
    // que a política de RLS compara. Os dois stores são preenchidos aqui, no
    // mesmo ponto e a partir da mesma resolução — o `organizationId` vem do
    // vínculo do usuário autenticado, nunca do corpo da requisição, e é essa
    // procedência que RLS **não** protegeria sozinho.
    return this.requestContext.runMerging(
      { organizationId: organizationContext.organizationId },
      () => runInTenant(organizationContext.organizationId, () => next()),
    );
  }
}
