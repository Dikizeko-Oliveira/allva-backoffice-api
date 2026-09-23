/**
 * O id externo da unidade do Google — anúncio ou grupo de recursos.
 *
 * O anúncio do Google é gravado pelo id cru (`123`), como sempre foi. O grupo de
 * recursos do Performance Max ganha prefixo (`asset_group:456`) porque mora na
 * mesma tabela e sob a mesma unicidade (`adAccountId + externalAdId`): o Google
 * não promete que ids de tipos diferentes nunca coincidam, e uma colisão
 * fundiria duas séries numa só sem erro nenhum.
 *
 * **Mora no domínio pelo mesmo motivo de `delivery-status.ts`**: o ingest
 * escreve este id e a escrita o lê. Duas cópias da regra divergiriam, e a
 * divergência apareceria como uma pausa enviada para o recurso errado.
 */

const ASSET_GROUP_PREFIX = 'asset_group:';

const NUMERIC_ID = /^\d+$/;

export type GoogleUnitRef =
  | { kind: 'AD'; adId: string }
  | { kind: 'ASSET_GROUP'; assetGroupId: string };

export function googleAssetGroupExternalId(assetGroupId: string): string {
  return `${ASSET_GROUP_PREFIX}${assetGroupId}`;
}

/**
 * `null` para o que não é id do Google: o valor é interpolado em GAQL e em
 * resource name, e um id não numérico não tem o que ler nem o que escrever.
 */
export function parseGoogleUnitExternalId(
  externalAdId: string,
): GoogleUnitRef | null {
  if (externalAdId.startsWith(ASSET_GROUP_PREFIX)) {
    const assetGroupId = externalAdId.slice(ASSET_GROUP_PREFIX.length);
    return NUMERIC_ID.test(assetGroupId)
      ? { kind: 'ASSET_GROUP', assetGroupId }
      : null;
  }

  return NUMERIC_ID.test(externalAdId)
    ? { kind: 'AD', adId: externalAdId }
    : null;
}

/** Os ids de um refresh dirigido, separados pelo recurso que os lê. */
export function splitGoogleUnitIds(externalAdIds: string[]): {
  adIds: string[];
  assetGroupIds: string[];
} {
  const adIds = new Set<string>();
  const assetGroupIds = new Set<string>();

  for (const externalAdId of externalAdIds) {
    const ref = parseGoogleUnitExternalId(externalAdId);
    if (ref?.kind === 'AD') adIds.add(ref.adId);
    if (ref?.kind === 'ASSET_GROUP') assetGroupIds.add(ref.assetGroupId);
  }

  return { adIds: [...adIds], assetGroupIds: [...assetGroupIds] };
}
