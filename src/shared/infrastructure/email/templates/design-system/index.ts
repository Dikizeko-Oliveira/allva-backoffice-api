/**
 * O design system dos e-mails da Allva.
 *
 * Três camadas: `theme` (cores da marca em hex, tipografia, logo), `components`
 * (os blocos de conteúdo) e `layout` (o envelope com cabeçalho, corpo e
 * rodapé). Um template novo importa daqui e descreve só o que muda.
 */
export * from './theme';
export * from './components';
export * from './layout';
