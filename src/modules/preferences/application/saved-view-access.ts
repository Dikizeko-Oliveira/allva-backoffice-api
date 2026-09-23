import { NotFoundException } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import type { SavedView } from '../domain/entities';
import type { SavedViewsRepositoryInterface } from '../domain/ports';
import { screenPermission } from '../domain/screens';

export function canUseScreen(operator: Operator, screen: string): boolean {
  const permission = screenPermission(screen);
  return permission !== null && operator.can(permission);
}

/**
 * Tela que o operador não enxerga responde `404`, não `403`: para ele, a tela
 * (e as visões salvas nela) não existe. `details.permission` continua indo, para
 * a web explicar o que falta.
 */
export function assertScreenAvailable(
  operator: Operator,
  screen: string,
): void {
  if (canUseScreen(operator, screen)) return;

  throw new NotFoundException({
    code: 'SAVED_VIEW_SCREEN_NOT_AVAILABLE',
    message: 'Saved view screen is not available',
    details: { permission: screenPermission(screen) ?? 'dashboard:read' },
  });
}

/** Só o dono altera ou apaga — compartilhada não é coletiva. */
export async function findOwnedView(
  repository: SavedViewsRepositoryInterface,
  operator: Operator,
  id: string,
): Promise<SavedView> {
  const view = await repository.findById(id);

  if (!view || !view.isOwnedBy(operator.id)) {
    throw new NotFoundException({
      code: 'SAVED_VIEW_NOT_FOUND',
      message: 'Saved view not found',
    });
  }

  return view;
}
