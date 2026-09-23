/**
 * Qual provedor guarda o objeto. Em minúsculas porque este é o valor que já foi
 * gravado em `reports.storage_provider` desde antes de existir uma escolha —
 * mudar a caixa agora partiria a coluna em dois vocabulários para a mesma coisa.
 *
 * A variável de ambiente que escolhe o provedor (`STORAGE_PROVIDER`) é maiúscula
 * por ser configuração humana; a tradução entre as duas é responsabilidade do
 * `resolveStorageProvider`, e só dele.
 */
export type StorageProviderName = 's3' | 'gcs';

export abstract class StoragePortInterface {
  /**
   * Nome do provedor por trás desta instância. Existe para que quem **persiste**
   * a referência ao objeto registre onde ele está de fato, e não um literal
   * fixo no código: uma linha que diz `s3` enquanto o arquivo está no GCS manda
   * qualquer leitura futura procurar no bucket errado.
   */
  abstract readonly provider: StorageProviderName;

  abstract upload(
    file: Buffer,
    filename: string,
    mimeType: string,
    folder?: string,
    campaignName?: string,
  ): Promise<{ url: string; key: string }>;

  abstract getPresignedUrl(
    filename: string,
    mimeType: string,
    folder?: string,
    campaignName?: string,
  ): Promise<{
    uploadUrl: string;
    fileUrl: string;
    key: string;
  }>;

  abstract deleteByUrl(fileUrl: string): Promise<void>;

  /**
   * Se `fileUrl` aponta para o bucket **desta** instalação.
   *
   * Existe por causa de uma coluna que guarda dois tipos de URL: a miniatura de
   * um criativo pode ser uma imagem que nós derivamos e subimos, ou a URL que a
   * própria plataforma entregou, hospedada no CDN da Meta ou do Google. Assinar
   * a segunda produziria uma URL sem sentido para um host que não é nosso —
   * então a pergunta precisa ser feita antes, e a resposta é síncrona porque
   * ela é feita uma vez por campo de cada resposta HTTP.
   */
  abstract ownsUrl(fileUrl: string): boolean;

  /**
   * Uma URL de **leitura** utilizável para um objeto que já está guardado.
   *
   * Recebe a URL gravada, e não a chave, porque é o que existe no banco: a
   * coluna nasceu guardando URL pública permanente, de quando o bucket era
   * legível por qualquer um. Reaproveitar o que está lá evita uma migração de
   * dados para reconstruir uma informação que a própria URL carrega.
   *
   * Devolve a URL intacta quando ela não é nossa — ver `ownsUrl`.
   */
  abstract getReadUrl(fileUrl: string, ttlSeconds?: number): Promise<string>;
}
