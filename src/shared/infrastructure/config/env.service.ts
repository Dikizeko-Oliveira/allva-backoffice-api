import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './env';

@Injectable()
export class EnvService {
  constructor(private configService: ConfigService<Env, true>) {}

  /**
   * Returns the validated value for `key`, typed as the schema declares it —
   * so an `.optional()` variable comes back as `string | undefined` and a call
   * site that needs a `string` has to deal with it (PLAN.md D-5, Sprint 6).
   *
   * The explicit annotation is load-bearing. Passing `Env[K]` as the first type
   * argument of `ConfigService.get` selects the `{ infer: true }` overload, whose
   * first type parameter is the *config object*, not the value — which resolved
   * every key to `never`. Since `never` is assignable to anything, no call site
   * ever complained, and optional variables passed silently as required.
   */
  get<K extends keyof Env>(key: K): Env[K] {
    return this.configService.get(key, { infer: true });
  }
}
