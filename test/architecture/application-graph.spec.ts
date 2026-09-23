import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

/**
 * O grafo de injeção da aplicação inteira resolve.
 *
 * **Este teste existe por um defeito real.** Em A2-S1, `ReportBuilderService`
 * passou a depender de `AdMetricsRepositoryInterface` e ninguém importou
 * `AdsModule` em `ReportsModule`. `pnpm build` passou (é só `tsc`), as 74 suítes
 * passaram (nenhuma monta o grafo inteiro) e a aplicação **não subia** — o erro
 * só aparecia em `NestFactory.create`, isto é, em produção.
 *
 * `compile()` resolve todo provider, controller e guard sem executar
 * `onModuleInit`: não abre conexão com Postgres nem com Redis, então roda no CI
 * sem infraestrutura. É a diferença entre "compila" e "monta", e é a segunda que
 * decide se o deploy sobe.
 */
describe('grafo de injeção da aplicação', () => {
  jest.setTimeout(120_000);

  it('resolve todo provider, controller e guard do AppModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
