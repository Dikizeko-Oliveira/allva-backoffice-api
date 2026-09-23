import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './source-tree';

/**
 * Leitor mínimo de `schema.prisma` para o harness de gates (§14.5).
 *
 * Não é um parser de Prisma — é o suficiente para responder às perguntas de
 * §14.5 sem depender do binário do Prisma nem de um banco de pé. Isso importa
 * porque os gates precisam rodar no mesmo `pnpm test` que roda em qualquer
 * máquina, inclusive sem `DATABASE_URL`.
 */

export type PrismaField = {
  name: string;
  type: string;
  optional: boolean;
  isList: boolean;
  attributes: string;
};

export type PrismaModel = {
  name: string;
  /** Nome da tabela em `@@map`, ou o nome do modelo quando não há map. */
  tableName: string;
  fields: PrismaField[];
  uniques: string[][];
  indexes: string[][];
  raw: string;
};

export type PrismaSchema = {
  models: PrismaModel[];
  enums: string[];
  raw: string;
};

export function loadPrismaSchema(): PrismaSchema {
  const raw = readFileSync(join(REPO_ROOT, 'prisma', 'schema.prisma'), 'utf8');
  return { raw, models: parseModels(raw), enums: parseEnums(raw) };
}

/** Todo o SQL de migração concatenado — partições, `CHECK` e índices parciais
 * vivem lá, não no `schema.prisma`. */
export function loadMigrationSql(): string {
  const migrationsDir = join(REPO_ROOT, 'prisma', 'migrations');
  if (!existsSync(migrationsDir)) return '';

  return readdirSync(migrationsDir)
    .map((entry) => join(migrationsDir, entry, 'migration.sql'))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

export function parseModels(schema: string): PrismaModel[] {
  const models: PrismaModel[] = [];
  const pattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(schema)) !== null) {
    const [, name, body] = match;
    models.push({
      name,
      tableName: readMapName(body) ?? name,
      fields: parseFields(body),
      uniques: parseAttributeLists(body, '@@unique'),
      indexes: parseAttributeLists(body, '@@index'),
      raw: body,
    });
  }

  return models;
}

export function parseEnums(schema: string): string[] {
  const names: string[] = [];
  const pattern = /^enum\s+(\w+)\s*\{/gm;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(schema)) !== null) names.push(match[1]);

  return names;
}

function parseFields(body: string): PrismaField[] {
  const fields: PrismaField[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) {
      continue;
    }

    const match = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, name, type, list, optional, attributes] = match;
    fields.push({
      name,
      type,
      isList: Boolean(list),
      optional: Boolean(optional),
      attributes: attributes ?? '',
    });
  }

  return fields;
}

function parseAttributeLists(body: string, attribute: string): string[][] {
  const lists: string[][] = [];
  const pattern = new RegExp(`${attribute}\\(\\s*\\[([^\\]]*)\\]`, 'g');

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    lists.push(
      match[1]
        .split(',')
        .map((entry) => entry.trim().replace(/\(.*\)$/, ''))
        .filter(Boolean),
    );
  }

  return lists;
}

function readMapName(body: string): string | null {
  const match = /@@map\("([^"]+)"\)/.exec(body);
  return match ? match[1] : null;
}

/** Um campo escalar (não relação) do modelo, se existir. */
export function scalarField(
  model: PrismaModel,
  name: string,
): PrismaField | undefined {
  return model.fields.find((field) => field.name === name);
}
