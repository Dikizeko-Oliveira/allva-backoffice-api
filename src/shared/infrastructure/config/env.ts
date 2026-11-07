import { z } from 'zod';

/**
 * Um campo obrigatório aqui significa "o processo não sobe sem ele".
 *
 * O backoffice-api tem duas dependências sem as quais nenhuma rota responde: o
 * banco próprio e o `allva-api`, de onde vem a identidade do operador. As duas
 * são críticas. Todo o resto tem default seguro ou é opcional.
 */
export const envSchema = z.object({
  /**
   * O banco **do backoffice**, nunca o do produto. Os dois têm históricos de
   * migração independentes; apontar para o `allva_db` misturaria os dois na
   * mesma `_prisma_migrations`.
   */
  DATABASE_URL: z.url(),
  /** Base do `allva-api`. Identidade, permissões e dado de produto vêm dele. */
  ALLVA_API_URL: z.url(),
  NODE_ENV: z.string().optional().default('development'),
  PORT: z.coerce.number().int().positive().optional().default(8081),
  FRONTEND_URL: z.string().optional(),
  /** Origens extras de CORS (além de `FRONTEND_URL`), separadas por vírgula. */
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  TRUSTED_PROXIES: z.string().optional(),
  // Segredo compartilhado com o painel e o `allva-api` (GAP-033): aceita o IP
  // em `x-allva-client-ip` como o do operador e o repassa ao `allva-api`.
  TRUSTED_CLIENT_IP_SECRET: z
    .string()
    .min(32, 'TRUSTED_CLIENT_IP_SECRET must be at least 32 characters')
    .optional(),
  DOCS_ENABLED: z.enum(['true', 'false']).optional(),
  // Liga o job que avalia as regras de alerta a cada 5 min (GAP-044). Só grava
  // `alert_events` neste banco; não envia nada para fora.
  ALERT_EVALUATION_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * Por quanto tempo a introspecção de um token vale. O teto de 60s é regra de
   * `docs/backoffice-api.md` §2: acima disso, um operador rebaixado ou com a
   * sessão revogada continua com o poder antigo por tempo demais.
   */
  OPERATOR_INTROSPECTION_CACHE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .default(60_000),
});

export type Env = z.infer<typeof envSchema>;
