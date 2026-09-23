import { SRC_ROOT, readSourceFiles } from './support/source-tree';

const controllers = readSourceFiles(SRC_ROOT).filter(
  (file) =>
    file.path.endsWith('.controller.ts') && /@Controller\(/.test(file.content),
);

/**
 * **Toda rota mora sob `/api/v1`**, como no `allva-api`.
 *
 * O prefixo fica no próprio `@Controller`, e não num `setGlobalPrefix`, pelo
 * mesmo motivo do produto: quem lê o controller vê a rota inteira, e um grep
 * pela URL que aparece no log da web cai direto no arquivo.
 */
describe('rotas versionadas', () => {
  it('encontra os controllers (o gate não passa por estar vazio)', () => {
    expect(controllers.length).toBeGreaterThan(5);
  });

  it('todo @Controller começa com /api/v1/', () => {
    const offenders = controllers
      .flatMap((file) =>
        [...file.content.matchAll(/@Controller\(\s*'([^']*)'/g)].map(
          (match) => ({ path: file.path, route: match[1] }),
        ),
      )
      .filter(({ route }) => !route.startsWith('/api/v1/'))
      .map(({ path, route }) => `${path} → '${route}'`);

    expect(offenders).toEqual([]);
  });

  it('nenhum @Controller sem rota explícita', () => {
    const bare = controllers
      .filter((file) => /@Controller\(\s*\)/.test(file.content))
      .map((file) => file.path);

    expect(bare).toEqual([]);
  });
});
