/**
 * Para qual front a sessão está sendo pedida.
 *
 * O login é uma porta só para cliente e operador, e continua sendo: a
 * identidade é uma, e toda rota autoriza por conta própria. O que a audiência
 * acrescenta é recusar **antes de a sessão existir** quem bateu na porta
 * errada — sem ela o backoffice emitia a sessão, lia `/auth/me`, descobria que
 * era cliente e revogava; e o produto do cliente aceitava um operador que só
 * ia encontrar 403 adiante.
 *
 * Opcional no login por senha para não quebrar cliente que ainda não envia.
 * Os logins federados (Google, Facebook) são sempre `app`: são portas de
 * cadastro do produto, e o backoffice não os oferece.
 */
export const SESSION_AUDIENCES = ['app', 'backoffice'] as const;

export type SessionAudience = (typeof SESSION_AUDIENCES)[number];
