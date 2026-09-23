/**
 * A forma monetária de §7.0.2 — o **único** shape de dinheiro que sai da API.
 *
 * A definição vive em `shared/domain/money.ts` porque os read models do domínio
 * também a usam, e domínio não importa infraestrutura (§16.6). Aqui ela é
 * reexportada para que a superfície HTTP tenha um caminho de import óbvio: quem
 * escreve um controller procura o shape em `envelope/`, não em `domain/`.
 */
export {
  moneyView,
  type MoneyView,
  type MoneyViewInput,
} from '@/shared/domain/money';
