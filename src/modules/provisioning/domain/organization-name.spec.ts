import { resolveDefaultOrganizationName } from './organization-name';

/**
 * O nome existe para que o cadastro não peça um formulário de organização. O que
 * este teste protege é o caso em que a fonte falha: `account.name` é validado
 * apenas por `@IsString()` no DTO de cadastro, e o nome vindo de Google/Facebook
 * pode chegar vazio. Uma organização sem nome legível é indistinguível das
 * outras no seletor de workspace.
 */
describe('o nome de uma organização provisionada', () => {
  it('usa o nome da conta', () => {
    expect(
      resolveDefaultOrganizationName({
        name: 'Dikezeko Oliveira',
        email: 'dike@empresa.com',
      }),
    ).toBe('Dikezeko Oliveira');
  });

  it('colapsa espaço interno e das pontas', () => {
    expect(
      resolveDefaultOrganizationName({
        name: '  Ana   Silva ',
        email: 'ana@empresa.com',
      }),
    ).toBe('Ana Silva');
  });

  it('cai para o local-part quando o nome é só espaço', () => {
    // `"   "` passa no `@IsString()` do DTO de cadastro — este é o caso real,
    // não uma hipótese.
    expect(
      resolveDefaultOrganizationName({
        name: '   ',
        email: 'contato@empresa.com',
      }),
    ).toBe('contato');
  });

  it.each([[null], [undefined], ['']])(
    'cai para o local-part quando o nome é %p',
    (name) => {
      expect(
        resolveDefaultOrganizationName({
          name,
          email: 'time@empresa.com',
        }),
      ).toBe('time');
    },
  );

  it('nunca devolve string vazia', () => {
    expect(
      resolveDefaultOrganizationName({ name: ' ', email: '@empresa.com' }),
    ).toBe('Minha organização');
  });
});
