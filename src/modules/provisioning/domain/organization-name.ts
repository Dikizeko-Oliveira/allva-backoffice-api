/**
 * O nome que uma organização provisionada automaticamente recebe.
 *
 * A organização deixou de ser um formulário que o usuário preenche: ela nasce
 * junto com a conta, e `name` é a única coluna obrigatória dela. Derivá-la do
 * nome da conta é o que permite o cadastro seguir com três campos em vez de
 * seis — a decisão de produto que motivou este provisionamento.
 *
 * O fallback não é zelo excessivo: `account.name` **não** é confiável. O DTO de
 * cadastro valida apenas `@IsString()` — `"   "` passa —, e o nome vindo de
 * Google/Facebook pode chegar vazio. Uma organização chamada `" "` fica
 * indistinguível das outras no seletor de workspace, que é a única forma de
 * trocar de contexto no produto.
 */
export function resolveDefaultOrganizationName(input: {
  name?: string | null;
  email: string;
}): string {
  const fromName = normalize(input.name);
  if (fromName) return fromName;

  // O local-part sempre existe: `@IsEmail` já recusou o que não tem um.
  const fromEmail = normalize(input.email.split('@')[0]);
  if (fromEmail) return fromEmail;

  return 'Minha organização';
}

/** Trim mais colapso de espaço interno: `"Ana   Silva "` vira `"Ana Silva"`. */
function normalize(value?: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}
