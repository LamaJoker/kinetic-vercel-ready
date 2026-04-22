/**
 * IdGeneratorPort — génération d'identifiants uniques.
 *
 * Implémentations : UuidGenerator (web crypto), SequentialIdGenerator (tests).
 */
export interface IdGeneratorPort {
  /** Retourne un nouvel ID unique sous forme de string */
  newId(): string;
}
