import { Injectable } from '@nestjs/common';
import { EnvService } from './env.service';

/**
 * Single source of truth for "where does the user-facing app live".
 *
 * There used to be two. `FRONTEND_URL` (validated, required at boot) backed the
 * welcome / verification / reset-password / invitation links, while an
 * undeclared `APP_URL` with a hardcoded `https://app.allva.com.br` fallback
 * backed the alert and daily-summary emails. In any environment that was not
 * production, the same inbox got some links pointing at the local app and
 * others pointing at production — and because `APP_URL` was in neither the
 * schema nor `.env.example`, there was no way to discover you had to set it.
 *
 * Provided by the global `EnvModule`, so no feature module needs to import
 * anything to inject it.
 */
@Injectable()
export class AppUrlService {
  constructor(private readonly env: EnvService) {}

  /** Base URL with any trailing slashes removed, so callers can concatenate a
   *  leading-slash path without producing a double slash. */
  get baseUrl(): string {
    return this.env.get('FRONTEND_URL').replace(/\/+$/, '');
  }

  /** `path` may be given with or without a leading slash. */
  pathTo(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  /**
   * Onde a própria API é alcançável de fora, ou `undefined` quando ninguém
   * disse. Mesma responsabilidade das duas de cima — "que URL absoluta vai
   * dentro do e-mail" —, e por isso mora aqui em vez de num segundo serviço.
   *
   * Devolve `undefined` em vez de adivinhar: chutar o host é como nasce um
   * e-mail de produção com link para `localhost`.
   */
  get apiBaseUrl(): string | undefined {
    const raw = this.env.get('API_PUBLIC_URL')?.trim();

    return raw ? raw.replace(/\/+$/, '') : undefined;
  }

  /** `undefined` quando `API_PUBLIC_URL` não foi configurada. */
  apiPathTo(path: string): string | undefined {
    const base = this.apiBaseUrl;

    return base ? `${base}/${path.replace(/^\/+/, '')}` : undefined;
  }
}
