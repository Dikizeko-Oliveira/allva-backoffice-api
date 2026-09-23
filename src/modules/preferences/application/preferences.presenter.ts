import type { OperatorPreference, SavedView } from '../domain/entities';
import type { OperatorPreferenceOutputDto, SavedViewOutputDto } from './dtos';

export function toOperatorPreferenceOutput(
  preference: OperatorPreference,
): OperatorPreferenceOutputDto {
  return {
    operatorId: preference.operatorId,
    lastWorkspace: preference.lastWorkspace,
    sidebarCollapsed: preference.sidebarCollapsed,
    density: preference.density,
    timezone: preference.timezone,
    updatedAt: preference.updatedAt,
  };
}

export function toSavedViewOutput(view: SavedView): SavedViewOutputDto {
  return {
    id: view.id,
    operatorId: view.operatorId,
    screen: view.screen,
    name: view.name,
    filters: view.filters,
    columns: view.columns,
    sort: view.sort,
    isDefault: view.isDefault,
    shared: view.shared,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}
