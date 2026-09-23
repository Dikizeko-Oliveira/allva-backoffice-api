/**
 * A versão do motor de recomendação, gravada em `Recommendation.engineVersion`.
 *
 * A **quarta** coisa versionada do sistema, ao lado de `algoVersion` (score),
 * `detectorVersion` (waste) e `measurementVersion` (outcome). Sem ela, comparar
 * a taxa de acerto de dois meses é comparar duas políticas diferentes achando
 * que é a mesma — e é essa comparação que autoriza a automação de §20-H3.
 *
 * Muda quando a **política** muda: guarda nova, limiar de entrada diferente,
 * ordem de alternativas alterada. Calibração de limiar do `DetectorProfile`
 * **não** muda esta versão — ela muda o corte do detector, não a regra do plano.
 */
export const RECOMMENDATION_ENGINE_VERSION = 'reco-v2.0.0';
