'use strict';

/**
 * Plugin ESLint local do harness de conformidade (A2-S0, achado D8).
 *
 * Os princípios normativos da arquitetura só sobrevivem com verificador
 * automatizado: sem um, degradam em ~3 sprints e viram comentário histórico.
 * As regras aqui são as que dá para verificar sintaticamente; as demais vivem
 * em `test/architecture/`, que roda no mesmo gate de `pnpm test`.
 */
const noPlatformConditional = require('./no-platform-conditional');

module.exports = {
  rules: {
    'no-platform-conditional': noPlatformConditional,
  },
};
