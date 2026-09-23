'use strict';

/**
 * P6 — **multi-plataforma por contrato, não por condicional.**
 *
 * `if (platform === 'META')` fora de um provider é a forma como a v1 espalhou
 * diferença de plataforma por trinta arquivos: cada nova plataforma exigia
 * caçar os `if` e cada um esquecido virava comportamento silenciosamente errado
 * para o TikTok. A diferença tem endereço declarado — `PlatformProfile` e os
 * gateways em `infrastructure/providers/` —, e só lá dentro é legítimo perguntar
 * qual plataforma é esta.
 *
 * A regra pega as três formas de perguntar:
 *
 *   - comparação: `platform === 'META'`, `integration.platform !== 'GOOGLE'`
 *   - `switch (ad.platform)` com `case`
 *   - pertinência: `['META','GOOGLE'].includes(platform)`
 *
 * Não pega — de propósito — indexação por plataforma (`PROFILES[platform]`),
 * que é justamente a forma correta: uma tabela declarativa, exaustiva por
 * construção, em que a plataforma nova aparece como chave faltando e não como
 * `else` esquecido.
 */

const PLATFORM_NAME = /^platforms?$/i;

/** `platform`, `ad.platform`, `this.platform`, `integration.platform`. */
function readsPlatform(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return PLATFORM_NAME.test(node.name);
  if (node.type === 'MemberExpression' && !node.computed) {
    return (
      node.property.type === 'Identifier' &&
      PLATFORM_NAME.test(node.property.name)
    );
  }
  return false;
}

/** `'META'` ou `Platform.META` — o outro lado da comparação. */
function isPlatformLiteral(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'MemberExpression' && !node.computed) {
    return (
      node.object.type === 'Identifier' && PLATFORM_NAME.test(node.object.name)
    );
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Proíbe condicional por plataforma fora de infrastructure/providers (P6).',
    },
    schema: [],
    messages: {
      conditional:
        'Condicional por plataforma fora de `infrastructure/providers/` (P6). ' +
        'Declare a diferença em `PlatformProfile` ou no gateway da plataforma.',
    },
  },

  create(context) {
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;

        const matches =
          (readsPlatform(node.left) && isPlatformLiteral(node.right)) ||
          (readsPlatform(node.right) && isPlatformLiteral(node.left));

        if (matches) context.report({ node, messageId: 'conditional' });
      },

      SwitchStatement(node) {
        if (readsPlatform(node.discriminant)) {
          context.report({ node: node.discriminant, messageId: 'conditional' });
        }
      },

      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property.type !== 'Identifier' ||
          !['includes', 'indexOf'].includes(callee.property.name)
        ) {
          return;
        }

        // `[...].includes(platform)` — mesma pergunta, outra sintaxe.
        if (
          callee.object.type === 'ArrayExpression' &&
          node.arguments.some((argument) => readsPlatform(argument))
        ) {
          context.report({ node, messageId: 'conditional' });
        }
      },
    };
  },
};
