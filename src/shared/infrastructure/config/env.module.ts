import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppUrlService } from './app-url.service';
import { ConfigReadinessService } from './config-readiness.service';
import { envSchema } from './env';
import { EnvService } from './env.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // `envSchema` carries the boot guard: critical variables are non-optional,
      // and conditionally-critical ones (billing webhook secrets in production)
      // are enforced by its `superRefine`. A failure here aborts startup.
      validate: (env) => envSchema.parse(env),
    }),
  ],
  // ConfigReadinessService covers the third tier — optional variables, reported at
  // boot instead of failing it.
  providers: [EnvService, AppUrlService, ConfigReadinessService],
  exports: [EnvService, AppUrlService],
})
export class EnvModule {}
