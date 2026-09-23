O Workspace Selector / Operations Hub do backoffice. Ela seria a primeira tela após o login e teria duas funções: contextualizar o operador e funcionar como camada visual de autorização.

O fluxo ficaria assim:

Login
  ↓
/workspace ou /home
  ↓
Boas-vindas + contexto do operador
  ↓
Setores permitidos pelo RBAC
  ↓
Seleciona um setor
  ↓
Entra no backoffice
  ↓
Sidebar contextualizada para aquele setor/role

Por exemplo, considerando os módulos que você já definiu para o backoffice:

Dashboard
Organizations
Users
Leads
Support
Subscriptions
Payments
Integrations
Operations
Audit
Settings

Eu não exibiria necessariamente um card por página. Agruparia por áreas operacionais, porque isso escala muito melhor.

Algo como:

Área	Conteúdo
Customer Operations	Organizations, Users, Leads
Support	Tickets, contatos, atendimento
Billing & Finance	Subscriptions, Payments
Platform Operations	Integrations, Operations
Governance	Audit
Administration	Settings

Assim, alguém de suporte não entra vendo uma lista enorme de funcionalidades. Veria algo como:

Bem-vindo, João

Escolha uma área para começar.

┌─────────────────────┐  ┌─────────────────────┐
│ Customer Operations │  │ Support             │
│                     │  │                     │
│ Organizations       │  │ Tickets             │
│ Users               │  │ Customer requests   │
│ Leads               │  │                     │
│                     │  │                     │
│ Entrar →            │  │ Entrar →            │
└─────────────────────┘  └─────────────────────┘

Enquanto alguém com papel de FINANCE poderia receber apenas:

┌─────────────────────┐
│ Billing & Finance   │
│                    │
│ Subscriptions      │
│ Payments           │
│                    │
│ Entrar →           │
└─────────────────────┘

E um SUPER_ADMIN ou operador com permissões amplas poderia visualizar todos os setores.

Eu evitaria amarrar isso diretamente ao role

Esse é provavelmente o ponto arquitetural mais importante.

Em vez de:

if (role === 'FINANCE') {
  showPayments = true
}

eu usaria permissões/capabilities:

permissions: [
  'organizations:read',
  'users:read',
  'leads:read',
  'support:read',
  'subscriptions:read',
  'payments:read',
  'integrations:read',
  'operations:execute',
  'audit:read',
  'settings:manage',
]

E os setores teriam requisitos:

const workspaces = [
  {
    id: 'customers',
    label: 'Customer Operations',
    href: '/organizations',
    permissions: [
      'organizations:read',
      'users:read',
      'leads:read',
    ],
  },

  {
    id: 'support',
    label: 'Support',
    href: '/support',
    permissions: ['support:read'],
  },

  {
    id: 'billing',
    label: 'Billing & Finance',
    href: '/subscriptions',
    permissions: [
      'subscriptions:read',
      'payments:read',
    ],
  },

  {
    id: 'platform',
    label: 'Platform Operations',
    href: '/operations',
    permissions: [
      'integrations:read',
      'operations:read',
    ],
  },

  {
    id: 'governance',
    label: 'Governance',
    href: '/audit',
    permissions: ['audit:read'],
  },
]

A regra poderia ser simplesmente:

const availableWorkspaces = workspaces.filter(workspace =>
  workspace.permissions.some(permission =>
    user.permissions.includes(permission)
  )
)

Isso é muito melhor porque daqui a alguns meses você pode ter:

SUPPORT_AGENT
SUPPORT_MANAGER
FINANCE_ANALYST
FINANCE_MANAGER
OPERATIONS_ANALYST
OPERATIONS_MANAGER
SALES
COMPLIANCE
ADMIN

sem precisar reescrever a navegação inteira.

E aplicaria exatamente a mesma regra no Sidebar

Esse ponto é essencial.

A home inicial e o sidebar não deveriam possuir regras independentes.

Eu teria uma configuração canônica:

const navigation = [
  {
    label: 'Organizations',
    href: '/organizations',
    permission: 'organizations:read',
  },
  {
    label: 'Users',
    href: '/users',
    permission: 'users:read',
  },
  {
    label: 'Leads',
    href: '/leads',
    permission: 'leads:read',
  },
  {
    label: 'Support',
    href: '/support',
    permission: 'support:read',
  },
  {
    label: 'Subscriptions',
    href: '/subscriptions',
    permission: 'subscriptions:read',
  },
]

E dela derivaria:

Home
Sidebar
Command palette
Breadcrumbs
Quick actions

Assim você evita o clássico problema:

O usuário não vê Payments no menu, mas consegue acessar /payments digitando a URL.

Obviamente, o backend continua sendo a autoridade final de autorização.

O frontend apenas melhora UX.

Eu também mudaria o comportamento do Dashboard

Hoje você disse que:

qualquer operador faz login e vai para dashboard.

Eu não faria mais isso.

Usaria:

/login
   ↓
/home

E o /dashboard passaria a ser um módulo real.

Por exemplo:

Operations Dashboard

Open support tickets        21
Pending leads                8
Failed integrations          2
Pending payments             4
Operational alerts           3

Mas cada métrica também seria filtrada de acordo com as permissões.

Ou seja, se FINANCE entrar no dashboard:

Subscriptions
Payments
Failed charges
MRR

Se SUPPORT entrar:

Open tickets
Average response time
Escalations
Unassigned tickets

Isso pode inclusive evoluir para um dashboard contextual por role.

Para a tela inicial, eu colocaria quatro elementos principais.

Header

ALLVA
Backoffice

                              João Silva
                              Finance Analyst
                              Logout

Eu provavelmente colocaria avatar/menu:

João Silva
Finance Analyst
──────────────
My account
Security
──────────────
Logout

Mesmo que My account ainda não exista, pode começar apenas com Logout.

Welcome

Algo relativamente simples:

Boa noite, João.

Bem-vindo ao Allva Operations.

Selecione uma área para continuar.

Abaixo poderia aparecer:

Finance Analyst · 2 áreas disponíveis

Isso deixa muito claro para o operador por que determinadas opções não aparecem.

Workspace cards

Cada card poderia ter:

icon

Billing & Finance

Gerencie assinaturas, pagamentos,
cobranças e informações financeiras.

Subscriptions · Payments

Entrar →

Eu adicionaria também um pequeno indicador quando houver algo que exige atenção:

Billing & Finance                         3

3 pagamentos requerem atenção

Isso transforma a tela em algo muito mais útil do que um simples seletor.

Outra coisa que eu colocaria seria uma pequena seção “Requires attention”, mas apenas se houver algo relevante para aquele operador.

Exemplo:

Requires attention

⚠ 2 integrations failed
○ 7 support tickets unassigned
○ 3 enterprise leads waiting for review

Naturalmente filtrado pelo RBAC.

Então a página ficaria conceitualmente assim:

┌──────────────────────────────────────────────────────────┐
│ ALLVA OPERATIONS                         João ▾           │
├──────────────────────────────────────────────────────────┤
│                                                          │
│ Boa noite, João.                                         │
│ Bem-vindo ao Allva Operations.                           │
│ Selecione uma área para continuar.                       │
│                                                          │
│ ┌───────────────────┐ ┌───────────────────┐              │
│ │ Customer Ops      │ │ Support           │              │
│ │                   │ │                   │              │
│ │ Organizations     │ │ 7 open tickets    │              │
│ │ Users             │ │                   │              │
│ │ Leads             │ │                   │              │
│ │                   │ │                   │              │
│ │ Entrar →          │ │ Entrar →          │              │
│ └───────────────────┘ └───────────────────┘              │
│                                                          │
│ Requires attention                                       │
│                                                          │
│ ⚠ 3 enterprise leads waiting for qualification          │
│ ⚠ 1 integration requires attention                      │
│                                                          │
└──────────────────────────────────────────────────────────┘
Tem uma decisão de UX que eu faria

Quando o operador clicar em uma área, eu não mudaria completamente o sistema como se fossem aplicações independentes.

Eu manteria o mesmo shell:

Allva Operations

[sidebar]

Customer Operations
  Organizations
  Users
  Leads

────────────

Support
  Tickets

────────────

Billing
  Subscriptions
  Payments

Mas somente os grupos autorizados aparecem.

Isso permite que alguém que tenha acesso a várias áreas transite entre elas sem ter que voltar obrigatoriamente para a home.

Eu adicionaria no topo do sidebar:

← Operations Home

ou o logo Allva funcionando como link para /home.

Também criaria uma proteção interessante para operadores que possuem uma única área.

Mesmo nesses casos eu manteria a home.

Pode parecer que redirecionar automaticamente economizaria um clique, mas a home tem valor porque:

mostra identidade do operador;
mostra contexto do acesso;
mostra alertas;
oferece logout;
oferece uma entrada consistente;
permite adicionar novidades futuramente;
evita comportamento diferente dependendo do role.

Portanto:

Login → Home → Workspace

para todo mundo.

A arquitetura poderia ficar assim
/auth/login

/home
   Operations Hub

/dashboard

/organizations
/users
/leads

/support

/subscriptions
/payments

/integrations
/operations

/audit

/settings

E eu ainda separaria conceitualmente:

Role
   ↓
Permissions
   ↓
Capabilities
   ↓
Navigation

em vez de:

Role
   ↓
Navigation

Isso vai combinar muito bem com a decisão que você já tomou anteriormente para a Allva de trabalhar com permissões mais granulares como actions:execute e actions:execute_sensitive, em vez de depender apenas de hierarquia de roles.

Uma estrutura que eu usaria seria:

type Permission =
  | 'dashboard:read'
  | 'organizations:read'
  | 'organizations:write'
  | 'users:read'
  | 'users:manage'
  | 'leads:read'
  | 'leads:manage'
  | 'support:read'
  | 'support:manage'
  | 'subscriptions:read'
  | 'subscriptions:manage'
  | 'payments:read'
  | 'payments:manage'
  | 'integrations:read'
  | 'integrations:manage'
  | 'operations:read'
  | 'actions:execute'
  | 'actions:execute_sensitive'
  | 'audit:read'
  | 'settings:read'
  | 'settings:manage'

E o endpoint de sessão do operador já retornaria algo como:

{
  "operator": {
    "id": "...",
    "name": "João Silva",
    "role": "FINANCE_ANALYST"
  },
  "permissions": [
    "dashboard:read",
    "subscriptions:read",
    "payments:read"
  ]
}

Daí o frontend praticamente não precisa saber o significado de FINANCE_ANALYST.

Ele só pergunta:

can('payments:read')

Essa é a parte que eu considero mais importante da mudança.

Seu conceito da tela de boas-vindas está certo. Eu só faria dela um verdadeiro Operations Hub, baseado em capabilities, e não uma simples página com cards condicionados por role.

Isso deixa o backoffice preparado para crescer sem virar uma coleção de if (role === ...).
