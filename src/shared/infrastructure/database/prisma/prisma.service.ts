import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../../../generated/prisma/client';
import { assertSafeTenantId, currentTenant } from './tenant-scope';

/**
 * O cliente Prisma, com o **tenant publicado ao Postgres** (R9).
 *
 * ## O problema que a extensão resolve
 *
 * A política de RLS compara `organization_id` com
 * `current_setting('app.organization_id')`, e `SET LOCAL` só vale **dentro de
 * uma transação**. A maioria das consultas do repositório não abre uma — então
 * ou cada uma passa a abrir, ou a garantia depende de quem escreve lembrar.
 *
 * A segunda opção não é garantia: é convenção com nome de garantia. A extensão
 * embrulha cada operação numa transação que seta o tenant antes de executar, e
 * quem escreve repositório não muda uma linha.
 *
 * ## O custo, declarado
 *
 * Uma consulta simples vira `BEGIN; SET LOCAL; SELECT; COMMIT`. Em Postgres
 * local isso é ~1 ms; o benchmark de `GET /ads` (33 ms com 10k anúncios contra
 * orçamento de 400) tem folga de uma ordem de grandeza para absorvê-lo.
 * **Medir depois de ligar é obrigatório**, e `pnpm bench:ads` é a régua.
 *
 * ## Por que sem tenant não é erro
 *
 * Fora de requisição — worker, cron, migração — não há tenant, e a extensão
 * não seta nada. Sob o papel `app_rw` a consulta devolve **zero linhas**; sob
 * `app_maintenance` (BYPASSRLS) devolve tudo, que é o que os jobs globais de
 * §8.8 precisam. A escolha é do papel na `DATABASE_URL`, não de um `if` aqui —
 * um `if` seria a porta que a política existe para fechar.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost')
        ? undefined
        : { rejectUnauthorized: false },
    });

    super({ adapter });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/**
 * A extensão que publica o tenant. Aplicada em `PrismaService` pelo módulo, e
 * exportada separada para que o teste de isolamento possa montá-la sobre um
 * cliente conectado como `app_rw` sem subir a aplicação inteira.
 */
export function withTenantScope<T extends PrismaClient>(client: T) {
  return client.$extends({
    query: {
      async $allOperations({ args, query }) {
        const tenant = currentTenant();

        /**
         * Sem tenant, **nada é setado** — e não há atalho aqui.
         *
         * A tentação seria tratar isso como "consulta livre". Sob `app_rw` ela
         * devolve zero linhas, que é falha **fechada**: o pior desfecho é uma
         * tela vazia, nunca dado do tenant errado.
         */
        if (!tenant) return query(args);

        /**
         * `SET LOCAL` e a operação **na mesma transação**, pela forma
         * sequencial de `$transaction`.
         *
         * A forma interativa (`$transaction(async tx => ...)`) parece mais
         * natural e não serve: reinvocar a operação pelo delegate de `tx`
         * dispararia esta mesma extensão de novo, em recursão infinita. A forma
         * de array recebe a promessa que `query(args)` já produziu — ela roda
         * uma vez, dentro da transação que declara o tenant.
         */
        const [, result] = await client.$transaction([
          client.$executeRawUnsafe(
            `SET LOCAL app.organization_id = '${assertSafeTenantId(tenant)}'`,
          ),
          query(args),
        ]);

        return result;
      },
    },
  });
}
