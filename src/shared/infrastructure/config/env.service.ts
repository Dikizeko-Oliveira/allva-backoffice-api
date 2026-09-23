import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './env';

@Injectable()
export class EnvService {
  constructor(private configService: ConfigService<Env, true>) {}

  /**
   * O valor validado de `key`, tipado como o schema declara — uma variável
   * `.optional()` volta como `string | undefined`, e quem precisa de `string`
   * tem que lidar com isso.
   */
  get<K extends keyof Env>(key: K): Env[K] {
    return this.configService.get(key, { infer: true });
  }
}
