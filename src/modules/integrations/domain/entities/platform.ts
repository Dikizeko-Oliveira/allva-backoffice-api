export type Platform = 'META' | 'GOOGLE' | 'TIKTOK';

export const PLATFORM_VALUES: readonly Platform[] = [
  'META',
  'GOOGLE',
  'TIKTOK',
] as const;

/**
 * Como cada plataforma se escreve quando o nome vai para os olhos do usuário.
 *
 * É tabela e não condicional de propósito (P6): plataforma nova aparece aqui
 * como chave faltando, verificada pelo compilador, e não como um `else`
 * esquecido que escreveria "TIKTOK" no meio de uma frase em português.
 */
const PLATFORM_LABELS: Record<Platform, string> = {
  META: 'Meta',
  GOOGLE: 'Google',
  TIKTOK: 'TikTok',
};

export function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS[platform];
}

const PLATFORM_TO_PROVIDER_TYPE: Record<
  Platform,
  'META' | 'GOOGLE' | 'TIKTOK'
> = {
  META: 'META',
  GOOGLE: 'GOOGLE',
  TIKTOK: 'TIKTOK',
};

const PLATFORM_TO_SLUG: Record<Platform, 'meta' | 'google' | 'tiktok'> = {
  META: 'meta',
  GOOGLE: 'google',
  TIKTOK: 'tiktok',
};

const SLUG_TO_PLATFORM: Record<string, Platform | undefined> = {
  meta: 'META',
  google: 'GOOGLE',
  tiktok: 'TIKTOK',
};

export function platformToProviderType(platform: Platform) {
  return PLATFORM_TO_PROVIDER_TYPE[platform];
}

export function platformToSlug(platform: Platform) {
  return PLATFORM_TO_SLUG[platform];
}

export function slugToPlatform(slug: string): Platform | null {
  return SLUG_TO_PLATFORM[slug.toLowerCase()] ?? null;
}
