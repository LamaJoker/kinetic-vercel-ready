import { cameraScanSupported, scanBarcodeWithCamera } from '../lib/barcode-camera';
import Alpine from 'alpinejs';
import { Capacitor } from '@capacitor/core';
import { MACRO_COLORS } from '../lib/palette';
import { hapticLight, hapticSuccess } from '../lib/haptics';
import type { ContextMenuRequest } from '../lib/context-menu';
import { getDeps } from '../deps';
import {
  appendToMeal,
  copyableMeals,
  DEFAULT_NUTRITION_PREFS,
  foodKey,
  isFavorite,
  lastGramsFor,
  MEAL_SLOTS,
  mealPortions,
  mealProteinTarget,
  mealSections,
  mealSlotForHour,
  mealTimingPlan,
  normalizeFavorites,
  normalizeNutritionPrefs,
  normalizeRecents,
  normalizeRecipes,
  portionSummary,
  pushRecent,
  recipePerServing,
  recipeServingPortion,
  recipeTotals,
  removeRecipe,
  sanitizeFood,
  shiftIsoDate,
  STORAGE_KEYS,
  toggleFavorite,
  upsertRecipe,
  validateRecipe,
  type CopyableMeal,
  type FoodPer100,
  type FoodPortion,
  type MealLog,
  type MealSection,
  type MealTiming,
  type NutritionPlan,
  type NutritionPrefs,
  type RecentFood,
  type Recipe,
} from '@kinetic/core';
import { notifyWriteFailed } from '../lib/write-errors';
import { notify } from '../lib/notify';

interface ScannedFoodEntry {
  name: string;
  kcalPer100: number;
  proteinPer100: number;
  carbsPer100: number;
  fatPer100: number;
}

interface NutritionStoreShape {
  plan: NutritionPlan | null;
  todayLog: MealLog[];
  init(): Promise<void>;
  recalculatePlan(): Promise<void>;
  addMealItem(mealName: string, food: unknown, grams: number): Promise<boolean>;
  applyTodayLog(next: MealLog[]): Promise<boolean>;
  removeMealItem(mealName: string, idx: number): Promise<void>;
  scanBarcode(barcode: string): Promise<ScannedFoodEntry | null>;
}

interface LocalFood {
  id: string;
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  category: string;
}

/** Barre de macro telle que la renvoie le store (`$store.nutrition.macroBars`). */
interface MacroBarLike {
  key: 'proteinG' | 'carbsG' | 'fatG';
  label: string;
  pct: number;
  over: boolean;
  detail: string;
  consumed: number;
}

/**
 * Couleurs des trois macros (lib/palette.ts, partagées avec le store) :
 * protéines violet, glucides turquoise, lipides ambre. Elles ne suivent pas le
 * thème d'accent, qui colore déjà l'anneau des calories.
 */
export { MACRO_COLORS };

export interface MacroView {
  key: MacroBarLike['key'];
  label: string;
  detail: string;
  over: boolean;
  pct: number;
  /** Style de la barre : largeur en % (lue par les tests e2e) + dégradé. */
  barStyle: string;
  /** Pastille de légende. */
  dotStyle: string;
}

/** 0 → 100, borné, arrondi. */
export function clampPct(value: number, target: number): number {
  if (!(target > 0) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round((value / target) * 100)));
}

/** Variable CSS d'un anneau `.k-ring-value` (`--p: 0…100`). */
export function ringVar(pct: number): string {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  return `--p: ${p}`;
}

/** Barres de macros prêtes à afficher : couleur, largeur, pastille. */
export function macroViews(bars: readonly MacroBarLike[]): MacroView[] {
  return bars.map((b) => {
    const c = MACRO_COLORS[b.key];
    const pct = Math.max(0, Math.min(100, Math.round(b.pct || 0)));
    // Un minimum visible dès la première bouchée, sinon 0 %.
    const width = b.consumed > 0 && pct < 2 ? 2 : pct;
    return {
      key: b.key,
      label: b.label,
      detail: b.detail,
      over: b.over,
      pct,
      barStyle: `width: ${width}%; background-image: linear-gradient(90deg, ${c.from}, ${c.to}); box-shadow: 0 0 12px -2px ${c.glow}`,
      dotStyle: `background-color: ${c.from}`,
    };
  });
}

/** Copie brute (sans Proxy Alpine), clonable par IndexedDB. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isoDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function localToFood(f: LocalFood): FoodPer100 {
  return {
    name: f.name,
    kcalPer100: f.kcal,
    proteinPer100: f.protein,
    carbsPer100: f.carbs,
    fatPer100: f.fat,
  };
}

/** Repas du journal prêt à afficher : anneau violet des protéines, copie d'hier possible. */
export interface MealSectionView extends MealSection {
  ringStyle: string;
  canCopyYesterday: boolean;
  /** « Protéines : 24 sur 40 g » (lecteurs d'écran). */
  proteinAria: string;
}

export function mealSectionViews(
  log: readonly MealLog[],
  yesterday: readonly MealLog[],
  targetG: number,
): MealSectionView[] {
  const yesterdayMeals = new Set(copyableMeals(yesterday).map((m) => m.mealName));
  return mealSections(log, MEAL_SLOTS, targetG).map((s) => ({
    ...s,
    ringStyle: ringVar(s.pct),
    canCopyYesterday: yesterdayMeals.has(s.mealName),
    proteinAria: `Protéines : ${Math.round(s.proteinG)} sur ${Math.round(s.targetG)} g`,
  }));
}

interface RecipeDraft {
  id: string;
  name: string;
  servings: number;
  ingredients: FoodPortion[];
  isNew: boolean;
}

let _foodDb: LocalFood[] | null = null;

async function loadFoodDb(): Promise<LocalFood[]> {
  if (_foodDb) return _foodDb;
  try {
    const res = await fetch('/foods.fr.json');
    _foodDb = (await res.json()) as LocalFood[];
    return _foodDb;
  } catch {
    return [];
  }
}

type AddTab = 'search' | 'recents' | 'favorites' | 'recipes';
type SheetMode = 'add' | 'recipe' | 'copy';

function emptyMeal(mealName: string) {
  return { mealName, name: '', grams: 100, kcal: 0, protein: 0, carbs: 0, fat: 0 };
}

export function nutrition() {
  return {
    showAddForm: false,
    trainingToday: new Date().getDay() !== 0 && new Date().getDay() !== 6,
    newMeal: emptyMeal(mealSlotForHour(new Date().getHours()) as string),
    mealSlots: [...MEAL_SLOTS] as string[],

    // ── Feuille : ajout (onglets), recette, copie d'un autre jour ─────────────
    sheetMode: 'add' as SheetMode,
    addTab: 'search' as AddTab,

    // ── Recherche d'aliments ──────────────────────────────────────────────────
    foodQuery: '',
    foodResults: [] as LocalFood[],
    selectedFood: null as LocalFood | null,
    foodDbReady: false,

    // ── Scan code-barres (OpenFoodFacts) ──────────────────────────────────────
    barcode: '',
    cameraScan: cameraScanSupported(),
    scanning: false,

    // ── Bibliothèque : récents, favoris, recettes, réglages ──────────────────
    recents: [] as RecentFood[],
    favorites: [] as FoodPer100[],
    recipes: [] as Recipe[],
    prefs: { ...DEFAULT_NUTRITION_PREFS } as NutritionPrefs,
    /** Champ « objectif par repas » : '' = automatique. */
    perMealInput: '' as string | number,
    yesterdayLog: [] as MealLog[],
    remindersNative: Capacitor.isNativePlatform(),

    // ── Annuler (ajout rapide, copie, recette) ────────────────────────────────
    undoLog: null as MealLog[] | null,
    undoLabel: '',
    _undoTimer: null as ReturnType<typeof setTimeout> | null,

    // ── Éditeur de recette ────────────────────────────────────────────────────
    recipeDraft: null as RecipeDraft | null,
    recipeQuery: '',
    recipeResults: [] as LocalFood[],
    recipeError: '',
    confirmDeleteRecipe: false,

    // ── Copier un repas d'un autre jour ───────────────────────────────────────
    copyTarget: '',
    copyDate: '',
    copyLog: [] as MealLog[],
    copyMeals: [] as CopyableMeal[],
    copyLoading: false,

    /** Barres de macros colorées (protéines, glucides, lipides). */
    get macroViews(): MacroView[] {
      const store = Alpine.store('nutrition') as { macroBars?: MacroBarLike[] } | undefined;
      return macroViews(store?.macroBars ?? []);
    },

    /** Anneau des calories (extérieur). */
    get kcalRingStyle(): string {
      const store = Alpine.store('nutrition') as
        | { plan: NutritionPlan | null; consumed?: { kcal: number } }
        | undefined;
      return ringVar(clampPct(store?.consumed?.kcal ?? 0, store?.plan?.macros?.kcal ?? 0));
    },

    /** Anneaux intérieurs des macros, dans l'ordre protéines, glucides, lipides. */
    macroRingStyle(key: MacroBarLike['key']): string {
      const v = this.macroViews.find((m) => m.key === key);
      return ringVar(v ? v.pct : 0);
    },

    macroRingColor(key: MacroBarLike['key']): string {
      return `color: ${MACRO_COLORS[key].from}`;
    },

    get mealTimings(): MealTiming[] {
      const store = Alpine.store('nutrition') as NutritionStoreShape | undefined;
      const plan = store?.plan;
      if (!plan) return [];
      return mealTimingPlan(plan, this.trainingToday);
    },

    // ── Protéines réparties ───────────────────────────────────────────────────
    get dailyProteinG(): number {
      const store = Alpine.store('nutrition') as NutritionStoreShape | undefined;
      return store?.plan?.macros?.proteinG ?? 0;
    },

    get autoPerMealG(): number {
      return mealProteinTarget(this.dailyProteinG, { ...this.prefs, proteinPerMealG: null });
    },

    get perMealTargetG(): number {
      return mealProteinTarget(this.dailyProteinG, this.prefs);
    },

    get sections(): MealSectionView[] {
      const store = Alpine.store('nutrition') as NutritionStoreShape | undefined;
      return mealSectionViews(store?.todayLog ?? [], this.yesterdayLog, this.perMealTargetG);
    },

    // ── Listes de la feuille d'ajout ──────────────────────────────────────────
    get recentViews() {
      return this.recents.map((r, i) => ({
        i,
        key: foodKey(r.food),
        name: r.food.name,
        summary: portionSummary(r),
        fav: isFavorite(this.favorites, r.food),
      }));
    },

    get favoriteViews() {
      return this.favorites.map((f, i) => ({
        i,
        key: foodKey(f),
        name: f.name,
        summary: portionSummary({ food: f, grams: lastGramsFor(this.recents, f) }),
      }));
    },

    get recipeViews() {
      return this.recipes.map((r) => {
        const s = recipePerServing(r);
        return {
          id: r.id,
          name: r.name,
          summary: `1 portion · ${s.grams} g · ${s.kcal} kcal · P ${Math.round(s.proteinG)} g`,
          detail: `${r.servings} portion${r.servings > 1 ? 's' : ''} · ${r.ingredients.length} ingrédient${r.ingredients.length > 1 ? 's' : ''}`,
        };
      });
    },

    get currentFood(): FoodPer100 | null {
      return sanitizeFood({
        name: this.newMeal.name,
        kcalPer100: this.newMeal.kcal,
        proteinPer100: this.newMeal.protein,
        carbsPer100: this.newMeal.carbs,
        fatPer100: this.newMeal.fat,
      });
    },

    get currentIsFavorite(): boolean {
      const food = this.currentFood;
      return food ? isFavorite(this.favorites, food) : false;
    },

    get sheetTitle(): string {
      if (this.sheetMode === 'recipe')
        return this.recipeDraft?.isNew ? 'Nouvelle recette' : 'Modifier la recette';
      if (this.sheetMode === 'copy') return `Copier dans « ${this.copyTarget} »`;
      return 'Ajouter un aliment';
    },

    get recipeSummary(): string {
      const d = this.recipeDraft;
      if (!d || d.ingredients.length === 0)
        return 'Ajoute des ingrédients pour calculer les macros.';
      const t = recipeTotals(d);
      const s = recipePerServing(d);
      return `Total ${t.grams} g · ${t.kcal} kcal — par portion : ${s.grams} g · ${s.kcal} kcal · P ${Math.round(s.proteinG)} · G ${Math.round(s.carbsG)} · L ${Math.round(s.fatG)} g`;
    },

    get recipeIngredientViews() {
      return (this.recipeDraft?.ingredients ?? []).map((ing, i) => ({
        i,
        name: ing.food.name,
        grams: ing.grams,
        summary: portionSummary(ing),
      }));
    },

    async init(): Promise<void> {
      const store = Alpine.store('nutrition') as NutritionStoreShape;
      await store.init();
      await store.recalculatePlan();
      await this.loadLibrary();
      // Précharger la DB en arrière-plan pour une recherche instantanée
      void loadFoodDb().then(() => {
        this.foodDbReady = true;
      });
    },

    async loadLibrary(): Promise<void> {
      try {
        const { storage } = await getDeps();
        const [recents, favorites, recipes, prefs, yesterday] = await Promise.all([
          storage.get<unknown>(STORAGE_KEYS.NUTRITION_RECENTS),
          storage.get<unknown>(STORAGE_KEYS.NUTRITION_FAVORITES),
          storage.get<unknown>(STORAGE_KEYS.NUTRITION_RECIPES),
          storage.get<unknown>(STORAGE_KEYS.NUTRITION_PREFS),
          storage.get<MealLog[]>(STORAGE_KEYS.NUTRITION_LOG(shiftIsoDate(isoDay(), -1))),
        ]);
        this.recents = normalizeRecents(recents);
        this.favorites = normalizeFavorites(favorites);
        this.recipes = normalizeRecipes(recipes);
        this.prefs = normalizeNutritionPrefs(prefs);
        this.perMealInput = this.prefs.proteinPerMealG ?? '';
        this.yesterdayLog = Array.isArray(yesterday) ? yesterday : [];
      } catch (err) {
        console.error('[nutrition] library load failed:', err);
      }
    },

    // ── Ouverture / fermeture de la feuille ───────────────────────────────────
    openAdd(mealName: string): void {
      this.sheetMode = 'add';
      this.newMeal.mealName = mealName || (mealSlotForHour(new Date().getHours()) as string);
      this.addTab = this.recents.length > 0 ? 'recents' : 'search';
      this.showAddForm = true;
    },

    closeSheet(): void {
      this.showAddForm = false;
      this.confirmDeleteRecipe = false;
    },

    setTab(tab: AddTab): void {
      this.addTab = tab;
    },

    setMeal(mealName: string): void {
      this.newMeal.mealName = mealName;
    },

    // ── Journal : écriture + annulation ───────────────────────────────────────
    async _readTodayLog(): Promise<MealLog[]> {
      const { storage } = await getDeps();
      return (await storage.get<MealLog[]>(STORAGE_KEYS.NUTRITION_LOG(isoDay()))) ?? [];
    },

    /** Ajoute des aliments à un repas, propose « Annuler ». */
    async _appendPortions(
      mealName: string,
      portions: FoodPortion[],
      label: string,
    ): Promise<boolean> {
      if (portions.length === 0) return false;
      const store = Alpine.store('nutrition') as NutritionStoreShape;
      try {
        const before = await this._readTodayLog();
        const next = appendToMeal(before, mealName, plain(portions), {
          id: newId(),
          at: new Date().toISOString(),
        });
        if (!(await store.applyTodayLog(next))) return false;
        hapticLight();
        this._offerUndo(before, label);
        this._afterLogChange();
        return true;
      } catch (err) {
        console.error('[nutrition] append failed:', err);
        notify('error', "Impossible d'ajouter. Réessaie.");
        return false;
      }
    },

    _offerUndo(before: MealLog[], label: string): void {
      this.undoLog = before;
      this.undoLabel = label;
      if (this._undoTimer) clearTimeout(this._undoTimer);
      this._undoTimer = setTimeout(() => {
        this.undoLog = null;
      }, 6000);
    },

    async undoLast(): Promise<void> {
      const before = this.undoLog;
      if (!before) return;
      this.undoLog = null;
      if (this._undoTimer) clearTimeout(this._undoTimer);
      const store = Alpine.store('nutrition') as NutritionStoreShape;
      if (await store.applyTodayLog(plain(before))) this._afterLogChange();
    },

    dismissUndo(): void {
      this.undoLog = null;
    },

    /** Rappel du soir recalculé (appli installée seulement). */
    _afterLogChange(): void {
      if (!Capacitor.isNativePlatform()) return;
      void import('../lib/protein-reminder').then((m) => m.syncProteinReminder());
    },

    async _remember(portion: FoodPortion): Promise<void> {
      this.recents = pushRecent(plain(this.recents), plain(portion), new Date().toISOString());
      try {
        const { storage } = await getDeps();
        await storage.set(STORAGE_KEYS.NUTRITION_RECENTS, plain(this.recents));
      } catch (err) {
        console.warn('[nutrition] recents save failed:', err);
      }
    },

    // ── Ajout ultra-rapide ────────────────────────────────────────────────────
    async quickAddRecent(i: number): Promise<void> {
      const r = this.recents[i];
      if (!r) return;
      const portion = plain({ food: r.food, grams: r.grams });
      if (await this._appendPortions(this.newMeal.mealName, [portion], `${r.food.name} ajouté`))
        await this._remember(portion);
    },

    async quickAddFavorite(i: number): Promise<void> {
      const f = this.favorites[i];
      if (!f) return;
      const portion = plain({ food: f, grams: lastGramsFor(this.recents, f) });
      if (await this._appendPortions(this.newMeal.mealName, [portion], `${f.name} ajouté`))
        await this._remember(portion);
    },

    async addRecipeServing(id: string): Promise<void> {
      const recipe = this.recipes.find((r) => r.id === id);
      const portion = recipe ? recipeServingPortion(plain(recipe)) : null;
      if (!recipe || !portion) {
        notify('warning', 'Cette recette ne contient aucun ingrédient.');
        return;
      }
      await this._appendPortions(
        this.newMeal.mealName,
        [portion],
        `1 portion de ${recipe.name} ajoutée`,
      );
    },

    /** Ouvre l'aliment dans le formulaire pour choisir une autre quantité. */
    adjustFood(food: FoodPer100, grams: number): void {
      this.selectedFood = null;
      this.newMeal = {
        mealName: this.newMeal.mealName,
        name: food.name,
        grams,
        kcal: food.kcalPer100,
        protein: food.proteinPer100,
        carbs: food.carbsPer100,
        fat: food.fatPer100,
      };
      this.foodQuery = food.name;
      this.foodResults = [];
      this.addTab = 'search';
    },

    adjustRecent(i: number): void {
      const r = this.recents[i];
      if (r) this.adjustFood(r.food, r.grams);
    },

    adjustFavorite(i: number): void {
      const f = this.favorites[i];
      if (f) this.adjustFood(f, lastGramsFor(this.recents, f));
    },

    // ── Favoris ───────────────────────────────────────────────────────────────
    async toggleFav(food: FoodPer100): Promise<void> {
      const wasFav = isFavorite(this.favorites, food);
      const previous = this.favorites;
      this.favorites = toggleFavorite(plain(this.favorites), plain(food));
      hapticLight();
      try {
        const { storage } = await getDeps();
        await storage.set(STORAGE_KEYS.NUTRITION_FAVORITES, plain(this.favorites));
      } catch (err) {
        this.favorites = previous;
        notifyWriteFailed('tes favoris', err);
        return;
      }
      notify('info', wasFav ? `${food.name} retiré des favoris` : `${food.name} épinglé en favori`);
    },

    toggleRecentFav(i: number): void {
      const r = this.recents[i];
      if (r) void this.toggleFav(r.food);
    },

    unpinFavorite(i: number): void {
      const f = this.favorites[i];
      if (f) void this.toggleFav(f);
    },

    toggleCurrentFav(): void {
      const food = this.currentFood;
      if (food) void this.toggleFav(food);
    },

    /** Appui long sur un aliment du journal. */
    itemMenu(menu: ContextMenuRequest, mealName: string, idx: number): void {
      const store = Alpine.store('nutrition') as NutritionStoreShape;
      const item = mealPortions(store.todayLog, mealName)[idx];
      if (!item) return;
      const fav = isFavorite(this.favorites, item.food);
      menu.show([
        {
          label: 'Ajouter encore',
          icon: 'plus',
          run: () => this._appendPortions(mealName, [item], `${item.food.name} ajouté`),
        },
        {
          label: fav ? 'Retirer des favoris' : 'Épingler en favori',
          icon: 'plus',
          run: () => this.toggleFav(item.food),
        },
        {
          label: 'Retirer du repas',
          icon: 'trash',
          danger: true,
          run: () => store.removeMealItem(mealName, idx),
        },
      ]);
    },

    // ── Copier un repas ───────────────────────────────────────────────────────
    async copyYesterday(mealName: string): Promise<void> {
      const portions = mealPortions(plain(this.yesterdayLog), mealName);
      if (portions.length === 0) {
        notify('info', `Aucun repas « ${mealName} » hier.`);
        return;
      }
      await this._appendPortions(
        mealName,
        portions,
        `Repas d'hier copié (${portions.length} aliment${portions.length > 1 ? 's' : ''})`,
      );
    },

    async openCopy(mealName: string): Promise<void> {
      this.sheetMode = 'copy';
      this.copyTarget = mealName;
      this.copyDate = shiftIsoDate(isoDay(), -1);
      this.showAddForm = true;
      await this.loadCopyDay();
    },

    async loadCopyDay(): Promise<void> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(this.copyDate)) {
        this.copyMeals = [];
        return;
      }
      this.copyLoading = true;
      try {
        const { storage } = await getDeps();
        const log = (await storage.get<MealLog[]>(STORAGE_KEYS.NUTRITION_LOG(this.copyDate))) ?? [];
        this.copyLog = log;
        this.copyMeals = copyableMeals(log);
      } finally {
        this.copyLoading = false;
      }
    },

    shiftCopyDay(days: number): void {
      const base = /^\d{4}-\d{2}-\d{2}$/.test(this.copyDate) ? this.copyDate : isoDay();
      const next = shiftIsoDate(base, days);
      if (next > isoDay()) return;
      this.copyDate = next;
      void this.loadCopyDay();
    },

    get copyDayLabel(): string {
      const today = isoDay();
      if (this.copyDate === shiftIsoDate(today, -1)) return 'Hier';
      if (this.copyDate === today) return "Aujourd'hui";
      const [y, m, d] = this.copyDate.split('-').map(Number) as [number, number, number];
      if (!y) return '';
      return new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
    },

    get copyIsToday(): boolean {
      return this.copyDate >= isoDay();
    },

    async copyFrom(mealName: string): Promise<void> {
      const portions = mealPortions(plain(this.copyLog), mealName);
      const ok = await this._appendPortions(
        this.copyTarget,
        portions,
        `${mealName} copié dans ${this.copyTarget}`,
      );
      if (ok) this.closeSheet();
    },

    // ── Recettes ──────────────────────────────────────────────────────────────
    newRecipe(): void {
      this.recipeDraft = { id: newId(), name: '', servings: 2, ingredients: [], isNew: true };
      this._openRecipeEditor();
    },

    editRecipe(id: string): void {
      const r = this.recipes.find((x) => x.id === id);
      if (!r) return;
      this.recipeDraft = { ...plain(r), isNew: false };
      this._openRecipeEditor();
    },

    _openRecipeEditor(): void {
      this.recipeError = '';
      this.recipeQuery = '';
      this.recipeResults = [];
      this.confirmDeleteRecipe = false;
      this.barcode = '';
      this.sheetMode = 'recipe';
      this.showAddForm = true;
    },

    backToAdd(): void {
      this.sheetMode = 'add';
      this.addTab = 'recipes';
      this.recipeDraft = null;
      this.confirmDeleteRecipe = false;
    },

    addIngredient(food: FoodPer100, grams: number): void {
      if (!this.recipeDraft) return;
      const clean = sanitizeFood(plain(food));
      if (!clean) return;
      this.recipeDraft.ingredients = [...this.recipeDraft.ingredients, { food: clean, grams }];
      this.recipeError = '';
      this.recipeQuery = '';
      this.recipeResults = [];
      hapticLight();
    },

    addIngredientFromSearch(food: LocalFood): void {
      this.addIngredient(localToFood(food), 100);
    },

    addIngredientFromFavorite(i: number): void {
      const f = this.favorites[i];
      if (f) this.addIngredient(f, lastGramsFor(this.recents, f));
    },

    addIngredientFromRecent(i: number): void {
      const r = this.recents[i];
      if (r) this.addIngredient(r.food, r.grams);
    },

    setIngredientGrams(i: number, value: string): void {
      const d = this.recipeDraft;
      const grams = Math.round(Number(value));
      if (!d || !d.ingredients[i] || !Number.isFinite(grams) || grams <= 0) return;
      d.ingredients = d.ingredients.map((ing, k) => (k === i ? { ...ing, grams } : ing));
    },

    removeIngredient(i: number): void {
      if (!this.recipeDraft) return;
      this.recipeDraft.ingredients = this.recipeDraft.ingredients.filter((_, k) => k !== i);
    },

    async searchRecipeFood(): Promise<void> {
      const q = this.recipeQuery.trim().toLowerCase();
      if (q.length < 2) {
        this.recipeResults = [];
        return;
      }
      const db = await loadFoodDb();
      this.recipeResults = db.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 6);
    },

    async _saveRecipes(): Promise<void> {
      const { storage } = await getDeps();
      await storage.set(STORAGE_KEYS.NUTRITION_RECIPES, plain(this.recipes));
    },

    async saveRecipe(): Promise<void> {
      const d = this.recipeDraft;
      if (!d) return;
      const draft = plain(d);
      const recipe: Recipe = {
        id: draft.id,
        name: draft.name.trim(),
        servings: Math.round(Number(draft.servings)),
        ingredients: draft.ingredients
          .map((i) => ({ food: i.food, grams: Number(i.grams) }))
          .filter((i) => Number.isFinite(i.grams)),
        updatedAt: new Date().toISOString(),
      };
      const error = validateRecipe(recipe);
      if (error) {
        this.recipeError = error;
        return;
      }
      try {
        this.recipes = upsertRecipe(plain(this.recipes), recipe);
        await this._saveRecipes();
        hapticSuccess();
        notify(
          'success',
          draft.isNew ? `Recette « ${recipe.name} » créée ✓` : 'Recette mise à jour ✓',
        );
        this.backToAdd();
      } catch (err) {
        console.error('[nutrition] recipe save failed:', err);
        notify('error', "Impossible d'enregistrer la recette. Réessaie.");
      }
    },

    async deleteRecipe(): Promise<void> {
      const d = this.recipeDraft;
      if (!d) return;
      if (!this.confirmDeleteRecipe) {
        this.confirmDeleteRecipe = true;
        return;
      }
      const previous = this.recipes;
      this.recipes = removeRecipe(plain(this.recipes), d.id);
      try {
        await this._saveRecipes();
        notify('info', `Recette « ${d.name} » supprimée`);
      } catch (err) {
        this.recipes = previous; // la recette est toujours enregistrée
        notifyWriteFailed('la suppression de la recette', err);
      }
      this.backToAdd();
    },

    // ── Réglages des protéines ────────────────────────────────────────────────
    async savePrefs(): Promise<void> {
      const raw = String(this.perMealInput ?? '').trim();
      const perMeal = raw === '' ? null : Number(raw);
      this.prefs = normalizeNutritionPrefs({ ...plain(this.prefs), proteinPerMealG: perMeal });
      this.perMealInput = this.prefs.proteinPerMealG ?? '';
      try {
        const { storage } = await getDeps();
        await storage.set(STORAGE_KEYS.NUTRITION_PREFS, plain(this.prefs));
      } catch (err) {
        notifyWriteFailed('tes réglages de protéines', err);
      }
      this._afterLogChange();
    },

    setMealsPerDay(n: number): void {
      this.prefs.mealsPerDay = n;
      void this.savePrefs();
    },

    async toggleProteinReminder(): Promise<void> {
      const on = !this.prefs.proteinReminder;
      if (on && this.remindersNative) {
        const { requestReminderPermission } = await import('../lib/reminders');
        if (!(await requestReminderPermission()))
          notify(
            'warning',
            'Autorise les notifications de Kinetic dans les réglages du téléphone.',
          );
      }
      this.prefs.proteinReminder = on;
      await this.savePrefs();
    },

    // ── Recherche (formulaire d'ajout) ────────────────────────────────────────
    /** Recherche dans la base locale — max 8 résultats. */
    async searchFood(): Promise<void> {
      const q = this.foodQuery.trim().toLowerCase();
      if (q.length < 2) {
        this.foodResults = [];
        return;
      }
      const db = await loadFoodDb();
      this.foodResults = db.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
    },

    /** Sélectionne un aliment de la base et pré-remplit le formulaire. */
    selectFood(food: LocalFood): void {
      this.selectedFood = food;
      this.newMeal.name = food.name;
      this.newMeal.kcal = food.kcal;
      this.newMeal.protein = food.protein;
      this.newMeal.carbs = food.carbs;
      this.newMeal.fat = food.fat;
      this.newMeal.grams = lastGramsFor(this.recents, localToFood(food));
      this.foodQuery = food.name;
      this.foodResults = [];
    },

    /** Cherche un produit par code-barres (OpenFoodFacts) et pré-remplit le formulaire. */
    async scanWithCamera(): Promise<void> {
      if (this.scanning) return;
      const result = await scanBarcodeWithCamera();
      if (result.status === 'ok') {
        this.barcode = result.code;
        await this.scanProduct();
      } else if (result.status === 'unavailable') {
        notify('info', 'Le scanner se prépare (première utilisation). Réessaie dans un instant.');
      }
    },

    async scanProduct(): Promise<void> {
      const code = this.barcode.trim();
      if (!code || this.scanning) return;
      this.scanning = true;
      try {
        const store = Alpine.store('nutrition') as NutritionStoreShape;
        const food = await store.scanBarcode(code);
        if (!food) return;
        // Éditeur de recette : le produit devient un ingrédient (100 g, à ajuster).
        if (this.sheetMode === 'recipe') {
          this.addIngredient(food, 100);
          this.barcode = '';
          notify('success', `${food.name} ajouté à la recette — ajuste la quantité`);
          return;
        }
        this.selectedFood = null;
        this.newMeal.name = food.name;
        this.newMeal.kcal = food.kcalPer100;
        this.newMeal.protein = food.proteinPer100;
        this.newMeal.carbs = food.carbsPer100;
        this.newMeal.fat = food.fatPer100;
        this.foodQuery = food.name;
        this.foodResults = [];
        notify('success', `${food.name} trouvé — vérifie la quantité ✓`);
      } finally {
        this.scanning = false;
      }
    },

    /** Vide la sélection pour permettre la saisie manuelle. */
    clearFoodSelection(): void {
      this.selectedFood = null;
      this.foodQuery = '';
      this.newMeal.name = '';
    },

    async logFood(): Promise<void> {
      const { name, grams, kcal, protein, carbs, fat, mealName } = this.newMeal;
      if (!name || grams <= 0) return;
      const macros = [kcal, protein, carbs, fat];
      if (macros.some((v) => !Number.isFinite(v) || v < 0)) {
        notify('warning', 'Valeurs invalides (doivent être ≥ 0).');
        return;
      }
      const food = {
        name,
        kcalPer100: kcal,
        proteinPer100: protein,
        carbsPer100: carbs,
        fatPer100: fat,
      };
      const store = Alpine.store('nutrition') as NutritionStoreShape;
      const added = await store.addMealItem(mealName, food, grams);
      if (!added) return;
      await this._remember({ food, grams });
      this._afterLogChange();

      // Reset (on garde le repas choisi pour enchaîner)
      this.newMeal = emptyMeal(mealName);
      this.foodQuery = '';
      this.selectedFood = null;
      this.foodResults = [];
      this.barcode = '';
      this.showAddForm = false;

      notify('success', `${name} ajouté ✓`);
    },
  };
}
