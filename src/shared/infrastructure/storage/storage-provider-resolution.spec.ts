import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { GcsStorageProvider } from './gcs-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { resolveStorageProvider } from './storage.module';

function envWith(values: Record<string, unknown>): EnvService {
  return {
    get: (key: string) => values[key],
  } as unknown as EnvService;
}

describe('resolveStorageProvider', () => {
  it('usa GCS quando nada foi dito', () => {
    // O schema já aplica o padrão; este teste garante que a fábrica concorda
    // com ele, e não que ela tem um segundo padrão só dela.
    expect(resolveStorageProvider(envWith({}))).toBeInstanceOf(
      GcsStorageProvider,
    );
  });

  it('usa GCS quando pedido', () => {
    expect(
      resolveStorageProvider(envWith({ STORAGE_PROVIDER: 'GCS' })),
    ).toBeInstanceOf(GcsStorageProvider);
  });

  it('usa S3 quando pedido', () => {
    expect(
      resolveStorageProvider(envWith({ STORAGE_PROVIDER: 'S3' })),
    ).toBeInstanceOf(S3StorageProvider);
  });

  /**
   * Sem bucket, o provedor escolhido continua sendo o escolhido.
   *
   * É o oposto do `EmailModule`, e de propósito: lá existe um destino inócuo
   * para onde cair, aqui não. Trocar de nuvem por causa de credencial faltando
   * gravaria o arquivo num bucket que ninguém está procurando.
   */
  it('não troca de provedor por falta de configuração', () => {
    expect(
      resolveStorageProvider(envWith({ STORAGE_PROVIDER: 'GCS' })),
    ).toBeInstanceOf(GcsStorageProvider);
    expect(
      resolveStorageProvider(envWith({ STORAGE_PROVIDER: 'S3' })),
    ).toBeInstanceOf(S3StorageProvider);
  });

  it('carrega o nome do provedor para quem persiste a referência ao objeto', () => {
    expect(resolveStorageProvider(envWith({})).provider).toBe('gcs');
    expect(
      resolveStorageProvider(envWith({ STORAGE_PROVIDER: 'S3' })).provider,
    ).toBe('s3');
  });
});
