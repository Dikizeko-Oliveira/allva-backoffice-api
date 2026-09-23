import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { join } from 'path';

import { CORRELATION_ID_HEADER } from './shared/infrastructure/context/correlation-id.middleware';
import { parseTrustProxySetting } from './shared/infrastructure/http/client-ip';
import { GlobalExceptionFilter } from './shared/infrastructure/http/filters/global-exception.filter';

// Swagger UI / scalar serve inline scripts+styles, so the strict API CSP is
// skipped for these paths (the baseline headers still apply everywhere).
const DOCS_PATHS = ['/docs', '/docs-json', '/scalar'];

function isDocsPath(path: string): boolean {
  return DOCS_PATHS.some(
    (docPath) => path === docPath || path.startsWith(`${docPath}/`),
  );
}

/**
 * Tudo que molda uma requisição antes de ela chegar num controller.
 *
 * Mora fora de `main.ts` para poder ser **exercitada por teste**. O arquivo de
 * entrada chama `bootstrap()` na importação, então um teste que quisesse subir
 * a aplicação de verdade não podia importá-lo — e a alternativa, repetir estas
 * chamadas no arnês, provaria que a cópia funciona e não que a aplicação
 * funciona. Foi assim que um `500` inexistente chegou a ser reportado como
 * defeito: o arnês subia o `AppModule` sem o `AuthGuard`, que só existia aqui.
 *
 * Swagger e `listen` ficam no entrypoint: são decisões de processo, não de
 * como a aplicação responde.
 */
export function configureApp(app: NestExpressApplication): void {
  /**
   * The API sits behind a proxy/load-balancer (and, for browser traffic, behind
   * the Next BFF). This setting is what lets express derive the real client IP
   * from X-Forwarded-For, which the audit trail records — so it is a trust
   * boundary, not a formality. Configure TRUSTED_PROXIES with the balancer's
   * addresses in production.
   */
  app.set('trust proxy', parseTrustProxySetting(process.env.TRUSTED_PROXIES));

  setupSecurityHeaders(app);
  setupCors(app);
  setupStaticAssets(app);
  setupValidation(app);
  setupExceptionFilter(app);
}

function setupExceptionFilter(app: NestExpressApplication) {
  app.useGlobalFilters(new GlobalExceptionFilter());
}

function setupSecurityHeaders(app: NestExpressApplication) {
  // Baseline headers for every response: HSTS, X-Content-Type-Options: nosniff,
  // X-Frame-Options: DENY, Referrer-Policy, etc. CSP is handled separately so
  // the docs pages keep working.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      hsts: { maxAge: 15552000, includeSubDomains: true },
    }),
  );

  // Strict CSP for the JSON API surface only (skipped for docs/scalar). A pure
  // API never needs to load remote scripts/styles, so lock everything to self.
  const apiCsp = helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
    },
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isDocsPath(req.path)) return next();
    return apiCsp(req, res, next);
  });
}

function setupCors(app: NestExpressApplication) {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  const allowlist = [
    process.env.FRONTEND_URL,
    ...(process.env.CORS_ALLOWED_ORIGINS?.split(',') ?? []),
  ]
    .map((origin) => origin?.trim())
    .filter((origin): origin is string => Boolean(origin));

  app.enableCors({
    origin: (origin, callback) => {
      // Allow non-browser / same-origin requests (no Origin header).
      if (!origin) return callback(null, true);
      // Outside production we stay permissive to ease local/preview work.
      if (!isProduction) return callback(null, true);
      if (allowlist.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      // O BFF propaga a correlação para cá; sem o header liberado, a cadeia
      // recomeça na API e o clique que a originou some do grafo.
      'X-Correlation-Id',
    ],
    exposedHeaders: [CORRELATION_ID_HEADER],
    optionsSuccessStatus: 204,
  });
}

function setupStaticAssets(app: NestExpressApplication) {
  app.useStaticAssets(join(__dirname, '..', 'public'));
}

function setupValidation(app: NestExpressApplication) {
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: ([error]) => {
        const [constraint] = Object.keys(error?.constraints ?? {});
        return new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: error?.constraints?.[constraint],
          field: error?.property,
        });
      },
    }),
  );
}
