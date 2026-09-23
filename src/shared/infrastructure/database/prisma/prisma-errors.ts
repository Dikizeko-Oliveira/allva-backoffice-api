/**
 * Códigos de erro do Prisma que a aplicação trata como caminho esperado.
 *
 * Checados por `code`, e não por `instanceof`: a camada de aplicação não deve
 * importar o tipo de erro do cliente para reconhecer uma corrida, e o mesmo
 * teste continua valendo se o repositório for trocado.
 */

/**
 * Violação de unicidade.
 *
 * Uma escrita que perde a corrida para outra idêntica não é falha: quem chama
 * relê e segue pelo caminho de "já existe". Deixá-la subir produz 500 num
 * pedido que o sistema sabe atender.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === 'P2002';
}
