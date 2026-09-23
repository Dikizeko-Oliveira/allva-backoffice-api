import type { SavedView } from '../entities';

export abstract class SavedViewsRepositoryInterface {
  abstract save(view: SavedView): Promise<void>;
  abstract update(view: SavedView): Promise<void>;
  abstract delete(id: string): Promise<void>;
  abstract findById(id: string): Promise<SavedView | null>;
  /**
   * As do operador e as compartilhadas pelos colegas; padrão primeiro, depois
   * por nome. O filtro por permissão de tela é do use case.
   */
  abstract listVisibleTo(
    operatorId: string,
    screen?: string,
  ): Promise<SavedView[]>;
}
