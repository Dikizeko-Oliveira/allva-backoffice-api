import type { PlatformPermission } from 'src/modules/auth/domain/platform-permissions';

/** Sobre o que se pode anotar. Os ids são do `allva-api`, sem FK. */
export const NOTE_SUBJECT_TYPES = [
  'ORGANIZATION',
  'ACCOUNT',
  'SALES_LEAD',
  'CONTRACT',
] as const;

export type NoteSubjectType = (typeof NOTE_SUBJECT_TYPES)[number];

/**
 * Ler (e escrever) nota sobre um assunto exige poder ver o assunto. Uma nota
 * sobre um contrato não pode vazar para quem não enxerga faturamento.
 */
export const NOTE_SUBJECT_PERMISSION: Readonly<
  Record<NoteSubjectType, PlatformPermission>
> = {
  ORGANIZATION: 'orgs:read',
  ACCOUNT: 'users:read',
  SALES_LEAD: 'leads:read',
  CONTRACT: 'billing:read',
};

/**
 * Quem pode editar ou apagar nota de outra pessoa. Moderação é configuração
 * da plataforma, não atendimento.
 */
export const NOTE_MODERATION_PERMISSION: PlatformPermission = 'settings:manage';
