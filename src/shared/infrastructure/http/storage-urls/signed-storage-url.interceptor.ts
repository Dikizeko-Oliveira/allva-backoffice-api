import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, mergeMap } from 'rxjs';
import { StoragePortInterface } from 'src/shared/application/ports/storage.port';

/**
 * Teto de nós visitados por resposta. Existe para que uma resposta
 * patologicamente grande custe uma varredura truncada em vez de um pico de CPU.
 */
const MAX_NODES = 5_000;

/** Profundidade máxima — corta ciclo e aninhamento absurdo pelo mesmo preço. */
const MAX_DEPTH = 12;

/**
 * Troca toda URL do nosso bucket, em qualquer resposta, por uma URL assinada.
 *
 * ## Por que global, e não em cada endpoint
 *
 * O bucket é privado: URL não assinada que chega ao browser é uma imagem
 * quebrada. Fazer a troca em cada ponto de serialização significaria acertar
 * hoje `avatarUrl`, `thumbnailUrl` e `downloadUrl` — e depender de alguém
 * lembrar no próximo endpoint que devolver um objeto guardado. **O modo de
 * falhar é silencioso** (imagem que não carrega, não exceção), então é
 * exatamente o tipo de coisa que não se descobre em revisão.
 *
 * Aqui a regra é uma só e vale por construção: *saiu daqui apontando para o
 * nosso bucket, sai assinada.*
 *
 * ## O que ele deliberadamente NÃO toca
 *
 * **URL que não é nossa.** `creatives.thumbnail_url` guarda tanto a miniatura
 * que derivamos quanto a que a plataforma entregou, hospedada no CDN da Meta ou
 * do Google. Quem decide é `ownsUrl`, no provider — assinar a da Meta produziria
 * uma URL para um host que não é nosso.
 *
 * **Qualquer coisa que não seja objeto ou array simples.** `Date`, `Buffer`,
 * streams e instâncias de classe passam intactas: reconstruí-las para trocar um
 * campo perderia o tipo, e a resposta de download de arquivo é justamente uma
 * dessas.
 *
 * ## Ele nunca derruba a resposta
 *
 * Falha de assinatura vira log e a carga segue com as URLs originais. Uma
 * miniatura que não carrega é um defeito visível e localizado; um 500 na
 * listagem inteira por causa dela seria trocar isso por uma indisponibilidade.
 */
@Injectable()
export class SignedStorageUrlInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SignedStorageUrlInterceptor.name);

  constructor(private readonly storage: StoragePortInterface) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(mergeMap((payload) => this.sign(payload)));
  }

  private async sign(payload: unknown): Promise<unknown> {
    const found = new Set<string>();
    this.collect(payload, found, 0, { visited: 0 });

    if (found.size === 0) return payload;

    const signed = new Map<string, string>();

    try {
      // Em paralelo e **deduplicado**: a mesma URL costuma repetir na resposta
      // (o avatar do dono em cada linha de uma lista), e assinar uma vez por
      // ocorrência multiplicaria o trabalho sem mudar o resultado.
      await Promise.all(
        [...found].map(async (url) => {
          signed.set(url, await this.storage.getReadUrl(url));
        }),
      );
    } catch (error) {
      this.logger.error(
        `storage.sign_failed — resposta segue com URLs não assinadas: ${
          (error as Error)?.message ?? error
        }`,
      );
      return payload;
    }

    return this.replace(payload, signed, 0);
  }

  /** Só strings que parecem URL chegam a `ownsUrl` — o resto nem vira `new URL`. */
  private isCandidate(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith('http');
  }

  private collect(
    value: unknown,
    found: Set<string>,
    depth: number,
    budget: { visited: number },
  ): void {
    if (depth > MAX_DEPTH || budget.visited++ > MAX_NODES) return;

    if (this.isCandidate(value)) {
      if (this.storage.ownsUrl(value)) found.add(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) this.collect(item, found, depth + 1, budget);
      return;
    }

    if (isPlainObject(value)) {
      for (const item of Object.values(value)) {
        this.collect(item, found, depth + 1, budget);
      }
    }
  }

  private replace(
    value: unknown,
    signed: Map<string, string>,
    depth: number,
  ): unknown {
    if (depth > MAX_DEPTH) return value;

    if (this.isCandidate(value)) return signed.get(value) ?? value;

    if (Array.isArray(value)) {
      return value.map((item) => this.replace(item, signed, depth + 1));
    }

    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.replace(item, signed, depth + 1),
        ]),
      );
    }

    return value;
  }
}

/**
 * Objeto literal, e nada mais. `Date`, `Buffer` e instâncias de classe têm
 * protótipo próprio e ficam de fora — recriá-las com `fromEntries` as
 * transformaria em objetos vazios, que é uma forma silenciosa de corromper a
 * resposta.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const proto: unknown = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}
