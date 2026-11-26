/**
 * Version du schéma des données locales (lib/migrations.ts). Inscrite dans les
 * sauvegardes complètes : une sauvegarde faite par une version plus récente de l'app
 * (schéma inconnu) n'est jamais restaurée par-dessus les données.
 */
export const LOCAL_SCHEMA_VERSION = 2;
