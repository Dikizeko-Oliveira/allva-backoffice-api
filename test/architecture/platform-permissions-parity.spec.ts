import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PLATFORM_PERMISSIONS } from 'src/modules/auth/domain/platform-permissions';

import { ALLVA_API_PLATFORM_PERMISSIONS } from './support/allva-api-platform-permissions';

const sorted = (values: readonly string[]) => [...values].sort();

/**
 * **O vocabulário de permissões é o mesmo do `allva-api`** (GAP-047).
 *
 * A lista local não filtra nada em tempo de execução, mas alimenta o `@IsIn`
 * dos DTOs: permissão que falta aqui vira 400 numa nota interna ou regra de
 * alerta que a restrinja. Faltaram quatro por um mês sem nenhum teste
 * reclamar.
 */
describe('vocabulário de permissões de plataforma', () => {
  it('é igual à cópia versionada do allva-api', () => {
    expect(sorted(PLATFORM_PERMISSIONS)).toEqual(
      sorted(ALLVA_API_PLATFORM_PERMISSIONS),
    );
  });

  it('não repete permissão', () => {
    expect(new Set(PLATFORM_PERMISSIONS).size).toBe(
      PLATFORM_PERMISSIONS.length,
    );
  });

  const allvaApiDir =
    process.env.ALLVA_API_DIR ?? resolve(__dirname, '../../../allva-api');
  const catalogFile = resolve(
    allvaApiDir,
    'src/modules/accounts/domain/platform-rbac.ts',
  );
  const siblingPresent = existsSync(catalogFile);

  // Sem o repositório irmão (CI), a cópia versionada é a referência.
  (siblingPresent ? it : it.skip)(
    'a cópia versionada ainda é a do allva-api ao lado',
    () => {
      const source = readFileSync(catalogFile, 'utf8');
      const block = /PLATFORM_PERMISSIONS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(
        source,
      );

      expect(block).not.toBeNull();

      const upstream = [...block![1].matchAll(/'([^']+)'/g)].map(
        (match) => match[1],
      );

      expect(sorted(ALLVA_API_PLATFORM_PERMISSIONS)).toEqual(sorted(upstream));
    },
  );
});
