import 'dotenv/config';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { join } from 'path';

import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { areDocsEnabled } from './shared/infrastructure/config/docs-visibility';

const PORT = Number(process.env.PORT) || 8081;

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  configureApp(app);

  if (areDocsEnabled()) {
    const document = setupSwagger(app);
    setupExtraRoutes(app, document);
  } else {
    new Logger('Bootstrap').log(
      'API docs disabled (DOCS_ENABLED=false or production default)',
    );
  }

  await app.listen(PORT, '0.0.0.0');
}

function setupSwagger(app: NestExpressApplication) {
  const config = new DocumentBuilder()
    .setTitle('Allva Backoffice API')
    .setDescription('Processos internos do backoffice Allva')
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      docExpansion: 'none',
      filter: true,
      showRequestDuration: true,
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'method',
    },
    customSiteTitle: 'ALLVA Backoffice Docs',
  });

  return document;
}

function setupExtraRoutes(app: NestExpressApplication, document: unknown) {
  app.getHttpAdapter().get('/docs-json', (_: Request, res: Response) => {
    res.json(document);
  });

  app.use('/scalar', (_: Request, res: Response) => {
    res.sendFile(join(__dirname, '..', 'public', 'scalar.html'));
  });
}

void bootstrap();
