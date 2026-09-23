/**
 * Os dois vocabulários de procedência, **no domínio** (§7.0.1, P7).
 *
 * Vivem aqui e não em `infrastructure/http` pela mesma razão que `MoneyView`
 * mudou de endereço em A2-S2: o domínio os usa e domínio não importa
 * infraestrutura (§16.6). Um detector precisa declarar `evidenceSufficiency` no
 * achado que produz, e ele não sabe que existe HTTP.
 *
 * `response-meta.ts` os reexporta: uma definição só, na camada que todas as
 * outras podem importar.
 */

/** §8.9 — quanto a janela já assentou contra a atribuição da conta. */
export type DataMaturity = 'IMMATURE' | 'SETTLING' | 'MATURE';

/**
 * §7.0.1 — quatro valores, não três.
 *
 * `PARTIAL` é o que permite emitir um achado de evidência real mas degradada
 * (benchmark de conta em vez de conjunto, série curta, componente por proxy) sem
 * mentir que ele vale tanto quanto um de evidência plena. Sem esse valor
 * intermediário o detector escolhe entre silêncio total e falsa confiança, e a
 * queda para linha de base de §10.3 (DEC-3) fica sem forma de se declarar.
 */
export type EvidenceSufficiency =
  | 'SUFFICIENT'
  | 'PARTIAL'
  | 'INSUFFICIENT'
  | 'MISSING_SCORE';
