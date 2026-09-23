import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Rota da superfície v1 cujo motor foi desligado pela reconstrução de A2-S1.
 *
 * A migração destrutiva levou as tabelas que esses módulos liam
 * (`metric_snapshots`, `waste_items` v1, `recommendations` v1), e os motores que
 * as substituem chegam nos sprints em que a arquitetura os redesenha — não antes.
 * Entre uma coisa e outra, a rota precisa dizer a verdade.
 *
 * **Por que 503 e não 404.** A rota não foi removida: ela volta, com contrato
 * novo, na data declarada. 404 diria "isto nunca existiu" e faria o cliente
 * apagar o caminho; 200 com lista vazia diria "não há desperdício", que é uma
 * afirmação sobre os dados do usuário — e falsa. 503 com `retryAfterSprint` é a
 * única das três que não mente.
 *
 * **Por que não usa o envelope de erro de §7.0.4.** Aquele vocabulário tem 13
 * categorias fechadas e descreve a superfície ads-first. Estas rotas são a
 * superfície legada sendo aposentada: usam a forma de erro que o resto do v1 já
 * usa, e somem quando o módulo for reescrito.
 */
export function parkedFeature(feature: string, returnsIn: string): never {
  throw new ServiceUnavailableException({
    code: 'FEATURE_REBUILDING',
    message: `${feature} está sendo reconstruído sobre o modelo ads-first e volta em ${returnsIn}.`,
    feature,
    returnsIn,
  });
}
