import { Prisma } from 'generated/prisma/client';

/**
 * A ponte entre o `unknown` do domínio e o `InputJsonValue` do Prisma ao
 * gravar uma coluna `Json`.
 *
 * Os dois descrevem o mesmo valor em tempo de execução; só discordam no papel,
 * porque `unknown` não é atribuível a `InputJsonValue`. Todo valor que chega
 * aqui veio de um corpo de requisição já validado ou de um literal montado no
 * código — JSON por construção. Centralizar é o que mantém este o **único**
 * passo sem checagem, em vez de um `as any` por repositório.
 */
export function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * Para coluna `Json?`: ausência vira SQL `NULL` (`DbNull`), não o literal JSON
 * `null` — são coisas diferentes para o Postgres, e só a primeira casa com
 * `IS NULL`.
 */
export function toNullablePrismaJson(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}
