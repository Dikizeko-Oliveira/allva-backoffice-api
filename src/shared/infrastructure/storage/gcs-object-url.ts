import { decodeObjectKey, encodeObjectKey } from './storage-object-key';

/** Host público padrão do Cloud Storage (endpoint XML/JSON de leitura). */
export const GCS_DEFAULT_HOST = 'https://storage.googleapis.com';

export type GcsUrlContext = {
  bucket: string;
  /** Domínio próprio/CDN na frente do bucket, quando houver. */
  publicBaseUrl?: string;
};

/** Sem barra final, para que a concatenação com a chave nunca duplique `/`. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * A URL pública de um objeto.
 *
 * Caminho (`/bucket/chave`) e não virtual-hosted (`bucket.storage.googleapis.com`)
 * porque bucket com ponto no nome — comum quando o nome é um domínio — quebra a
 * validação de certificado na forma virtual-hosted. É também a forma que o
 * próprio SDK devolve em `File#publicUrl()`.
 *
 * Continua valendo o mesmo pressuposto do S3: **quem torna o objeto legível é a
 * política do bucket**, não esta função. Nenhum ACL é aplicado no upload.
 */
export function buildGcsObjectUrl(key: string, context: GcsUrlContext): string {
  const base = context.publicBaseUrl?.trim()
    ? trimTrailingSlash(context.publicBaseUrl.trim())
    : `${GCS_DEFAULT_HOST}/${context.bucket}`;

  return `${base}/${encodeObjectKey(key)}`;
}

/**
 * A chave de volta, a partir de uma URL que este serviço tenha emitido.
 *
 * Aceita as três formas que podem estar gravadas em banco, porque a coluna
 * guarda o que era verdade no dia do upload e não é reescrita quando a
 * configuração muda:
 *
 * 1. domínio próprio/CDN (`https://cdn.exemplo.com/pasta/arquivo.png`);
 * 2. caminho (`https://storage.googleapis.com/bucket/pasta/arquivo.png`);
 * 3. virtual-hosted (`https://bucket.storage.googleapis.com/pasta/arquivo.png`).
 *
 * O prefixo do bucket só é removido quando ele é de fato o primeiro segmento —
 * uma chave que por acaso comece com o nome do bucket (`meu-bucket-backup/…`)
 * seria decapitada por um `startsWith` ingênuo, e o delete erraria de objeto.
 */
export function extractGcsObjectKey(
  fileUrl: string,
  context: GcsUrlContext,
): string {
  const url = new URL(fileUrl);
  const path = url.pathname.replace(/^\/+/, '');

  const base = context.publicBaseUrl?.trim();

  if (base) {
    const baseUrl = new URL(trimTrailingSlash(base));
    const basePath = baseUrl.pathname.replace(/^\/+|\/+$/g, '');

    if (url.host === baseUrl.host) {
      return decodeObjectKey(stripLeadingSegment(path, basePath));
    }
  }

  // Virtual-hosted: o bucket está no host, então o caminho inteiro é a chave.
  if (url.host.startsWith(`${context.bucket}.`)) {
    return decodeObjectKey(path);
  }

  return decodeObjectKey(stripLeadingSegment(path, context.bucket));
}

/** Remove `prefix` de `path` apenas se ele for um prefixo de segmentos inteiros. */
function stripLeadingSegment(path: string, prefix: string): string {
  if (!prefix) return path;

  return path === prefix || path.startsWith(`${prefix}/`)
    ? path.slice(prefix.length).replace(/^\/+/, '')
    : path;
}

/**
 * Se a URL aponta para este bucket.
 *
 * A pergunta existe porque `creatives.thumbnail_url` guarda dois tipos de URL:
 * a miniatura que nós derivamos e subimos, e a que a plataforma entregou,
 * hospedada no CDN dela. Assinar a segunda produziria uma URL para um host que
 * não é nosso — sintaticamente válida, inútil na prática.
 *
 * URL malformada responde `false` em vez de estourar: isto roda sobre o que
 * está gravado no banco, e uma linha antiga estranha não pode derrubar a
 * resposta inteira.
 */
export function ownsGcsUrl(fileUrl: string, context: GcsUrlContext): boolean {
  let url: URL;

  try {
    url = new URL(fileUrl);
  } catch {
    return false;
  }

  const base = context.publicBaseUrl?.trim();

  if (base) {
    try {
      if (url.host === new URL(trimTrailingSlash(base)).host) return true;
    } catch {
      // Domínio próprio malformado não invalida as outras duas formas.
    }
  }

  if (!context.bucket) return false;

  const defaultHost = new URL(GCS_DEFAULT_HOST).host;

  // Virtual-hosted (`bucket.storage.googleapis.com`) ou caminho
  // (`storage.googleapis.com/bucket/...`) — nas duas o bucket precisa bater.
  if (url.host === `${context.bucket}.${defaultHost}`) return true;

  return (
    url.host === defaultHost &&
    url.pathname.replace(/^\/+/, '').startsWith(`${context.bucket}/`)
  );
}
