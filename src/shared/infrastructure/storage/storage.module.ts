import { Module } from '@nestjs/common';
import { StoragePortInterface } from 'src/shared/application/ports/storage.port';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { GcsStorageProvider } from './gcs-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';

/**
 * Escolhe o provedor por `STORAGE_PROVIDER`. Padrão: GCS.
 *
 * **Não há degradação silenciosa aqui, e é de propósito.** O `EmailModule` cai
 * no console quando falta credencial porque existe um destino inócuo para onde
 * cair; storage não tem equivalente — mandar o upload para a outra nuvem seria
 * pior do que falhar, porque o arquivo *pareceria* salvo e ninguém saberia em
 * qual bucket procurar.
 *
 * O provedor escolhido é portanto sempre construído, mesmo sem bucket: ele se
 * recusa na primeira chamada com `STORAGE_NOT_CONFIGURED`, e a ausência é
 * anunciada no boot pelo `ConfigReadinessService`. Storage é da camada opcional
 * (P-6) — configuração incompleta não pode derrubar o processo.
 *
 * Resolvido em `useFactory`, e não em `useClass`, porque a decisão depende do
 * `EnvService`: em tempo de definição do módulo o container ainda não existe e a
 * única leitura possível seria `process.env` cru, contornando o schema validado.
 */
export function resolveStorageProvider(env: EnvService): StoragePortInterface {
  if (env.get('STORAGE_PROVIDER') === 'S3') {
    return new S3StorageProvider(env);
  }

  return new GcsStorageProvider(env);
}

@Module({
  providers: [
    {
      provide: StoragePortInterface,
      inject: [EnvService],
      useFactory: resolveStorageProvider,
    },
  ],
  exports: [StoragePortInterface],
})
export class StorageModule {}
