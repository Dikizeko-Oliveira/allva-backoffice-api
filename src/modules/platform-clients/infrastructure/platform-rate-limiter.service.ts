import { Injectable, Logger } from '@nestjs/common';
import {
  TokenBucketConfig,
  TokenBucketState,
  consume,
  createBucket,
} from '../domain/token-bucket';

/**
 * Orçamento de chamadas **por integração** (R4).
 *
 * Uma credencial = um balde. Leitura e escrita da mesma conta competem pelo
 * mesmo saldo porque a plataforma as conta juntas: separar os baldes faria o
 * limite efetivo ser o dobro do declarado, e a plataforma cortaria tudo — inclusive
 * as escritas, que são as que movem dinheiro.
 *
 * Em memória e por processo em A2-S1. Com N réplicas o teto efetivo é N×limite,
 * o que é aceitável enquanto o ingest é o único consumidor e ele roda com lock
 * por conta; A2-S3 move o estado para Redis junto com o lease de `JobRun`, que é
 * quando passa a haver concorrência real entre réplicas.
 */
/** O que saiu de fato por integração — o insumo de toda decisão sobre R4. */
export type CallAccounting = {
  integrationId: string;
  granted: number;
  denied: number;
  since: Date;
};

@Injectable()
export class PlatformRateLimiterService {
  private readonly logger = new Logger(PlatformRateLimiterService.name);
  private readonly buckets = new Map<string, TokenBucketState>();

  /**
   * **Contabilidade de chamadas** (A2-S9, entrega 9).
   *
   * A2-S8 transferiu a chamada de reach de 7 dias para cá porque *"a condição
   * exige volume medido de chamadas, e não há medição"*. Isto é a medição: o
   * balde já sabia quantas concedeu — o que faltava era guardar o número em vez
   * de descartá-lo.
   *
   * Em memória e por processo, como o próprio balde: com N réplicas o total real
   * é a soma delas. Serve para responder "quanto este ingest gasta?" numa
   * réplica, que é a pergunta que a decisão de DEC-4 precisa — e não para
   * cobrança nem para alerta, que exigiriam estado compartilhado.
   */
  private readonly accounting = new Map<
    string,
    { granted: number; denied: number; since: Date }
  >();

  /** Padrão conservador: 5 chamadas/s com rajada de 20. */
  private readonly defaultConfig: TokenBucketConfig = {
    capacity: 20,
    refillPerSecond: 5,
  };

  /**
   * Tenta reservar uma chamada. Devolve `retryAfterMs > 0` quando não há saldo —
   * quem chama **espera**, não insiste: um laço de tentativa queima a cota que o
   * balde existe para proteger.
   */
  tryAcquire(
    integrationId: string,
    cost = 1,
    config: TokenBucketConfig = this.defaultConfig,
    now: number = Date.now(),
  ): { allowed: boolean; retryAfterMs: number } {
    const state = this.buckets.get(integrationId) ?? createBucket(config, now);
    const result = consume(state, config, now, cost);

    this.buckets.set(integrationId, result.state);
    this.record(integrationId, result.allowed, cost);

    if (!result.allowed) {
      this.logger.debug(
        `platform.rate_limited integrationId=${integrationId} retryAfterMs=${result.retryAfterMs}`,
      );
    }

    return { allowed: result.allowed, retryAfterMs: result.retryAfterMs };
  }

  /** O que esta réplica concedeu e recusou, por integração. */
  accountingFor(integrationId: string): CallAccounting | null {
    const entry = this.accounting.get(integrationId);
    if (!entry) return null;

    return { integrationId, ...entry };
  }

  snapshot(): CallAccounting[] {
    return [...this.accounting.entries()].map(([integrationId, entry]) => ({
      integrationId,
      ...entry,
    }));
  }

  /** Descarta o balde de uma integração desconectada. */
  forget(integrationId: string): void {
    this.buckets.delete(integrationId);
    this.accounting.delete(integrationId);
  }

  private record(integrationId: string, allowed: boolean, cost: number): void {
    const entry = this.accounting.get(integrationId) ?? {
      granted: 0,
      denied: 0,
      since: new Date(),
    };

    // O custo, não a chamada: uma operação que reserva três tokens gasta três
    // do orçamento da plataforma, e contá-la como uma subestimaria o consumo
    // exatamente nas chamadas mais caras.
    if (allowed) entry.granted += cost;
    else entry.denied += cost;

    this.accounting.set(integrationId, entry);
  }
}
