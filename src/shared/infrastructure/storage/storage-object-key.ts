import { randomUUID } from 'crypto';
import { extname } from 'path';

/**
 * O nome do objeto dentro do bucket, igual para todo provedor.
 *
 * Estava dentro do provider S3 e saiu de lá quando o GCS entrou: se cada
 * provedor gerasse a própria chave, migrar de um para o outro deixaria de ser
 * uma troca de destino e passaria a ser uma troca de *layout* — o mesmo upload
 * pousando em caminhos diferentes conforme quem estivesse ligado.
 *
 * O sufixo aleatório não é decoração. Sem ele, dois uploads do mesmo arquivo na
 * mesma pasta se sobrescrevem em silêncio, e o objeto antigo — já referenciado
 * por algum registro — passa a devolver conteúdo alheio.
 */
export function buildObjectKey(
  filename: string,
  folder: string,
  campaignName?: string,
): string {
  const fileExtension = extname(filename);
  const source = campaignName ?? filename.replace(fileExtension, '');
  const slug = slugify(source);
  const uniqueId = randomUUID().split('-')[0];

  return `${folder}/${slug}-${uniqueId}${fileExtension}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

/**
 * Cada segmento é escapado por si: `encodeURIComponent` na chave inteira
 * transformaria as barras em `%2F` e a URL deixaria de ser legível — e, num
 * bucket servido por CDN, deixaria de resolver.
 */
export function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/** O inverso de `encodeObjectKey`, aplicado ao caminho já extraído da URL. */
export function decodeObjectKey(path: string): string {
  return path.split('/').map(decodeURIComponent).join('/');
}
