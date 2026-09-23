import { createHash } from 'node:crypto';
import type { FindingType } from './contracts/finding-catalog';

/**
 * `fingerprint = sha256(adId | type)` — **sem versão** (§10.7 passo 6).
 *
 * A ausência da versão é a decisão: com `detectorVersion` na chave, cada bump do
 * detector reabriria todo o desperdício da base como achado novo, `occurrences`
 * voltaria a 1 e o histórico de recorrência — que é sinal usado por P8 —
 * evaporaria a cada deploy. A versão fica nas colunas, onde explica o achado sem
 * fragmentar a identidade dele.
 *
 * Também sem a janela: `windowDays` é configuração da organização (DEC-11), e
 * trocá-la de 14 para 7 duplicaria cada item aberto em vez de atualizá-lo.
 */
export function fingerprintOf(adId: string, type: FindingType): string {
  return createHash('sha256').update(`${adId}|${type}`).digest('hex');
}
