import { Injectable } from '@nestjs/common';
import {
  Permission,
  ROLE_PERMISSIONS,
  roleHasPermission,
} from 'src/modules/organizations/domain/rbac';
import { WorkspaceContext } from 'src/modules/organizations/application/workspace-context';

/**
 * Single source of truth for "what can the current request do". Permissions are
 * always derived from the server-resolved WorkspaceContext — never from
 * client-supplied data — so the backend stays the only authority on
 * authorization.
 *
 * - `ORGANIZATION` -> a matriz `ROLE_PERMISSIONS` indexada pelo papel da
 *   participação. Nenhuma lógica de RBAC é duplicada aqui.
 * - `NO_ORGANIZATION` -> **lista vazia**, porque é o que é verdade.
 *
 * A lista vazia substituiu um conjunto de quatro permissões pessoais
 * (`manage_personal_billing` e companhia) que existia desde antes do produto ser
 * organization-first. Nenhum guard as verificava e nenhuma tela as lia: elas não
 * concediam nada, apenas faziam o `/auth/me` afirmar autoridade que não existia.
 * Foi o que deixou a tela de organização em skeleton eterno — dado carregado,
 * nenhuma permissão de organização para renderizá-lo. Uma conta sem organização
 * não pode nada dentro de uma, e dizer isso é mais útil do que fingir o
 * contrário.
 */
@Injectable()
export class PermissionResolverService {
  resolvePermissions(context: WorkspaceContext): Permission[] {
    if (context.type === 'NO_ORGANIZATION') return [];

    return [...ROLE_PERMISSIONS[context.role]];
  }

  /**
   * Authorization check for an ORGANIZATION-scoped permission. Sem organização
   * a resposta é sempre `false` — recurso de organização exige contexto de
   * organização.
   */
  can(context: WorkspaceContext, permission: Permission): boolean {
    if (context.type === 'ORGANIZATION') {
      return roleHasPermission(context.role, permission);
    }

    return false;
  }
}
