import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

/**
 * O grafo de injeção da aplicação inteira resolve.
 *
 * `pnpm build` é só `tsc`: um provider que ninguém registrou compila e só
 * explode em `NestFactory.create`, isto é, no deploy. `compile()` resolve todo
 * provider, controller e guard sem abrir conexão com o banco nem chamar o
 * `allva-api`, então roda no CI sem infraestrutura.
 */
describe('grafo de injeção da aplicação', () => {
  jest.setTimeout(60_000);

  it('resolve todo provider, controller e guard do AppModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
