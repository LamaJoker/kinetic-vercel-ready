/**
 * Composants système façon iOS, chargés à part par router.ts (hors JS initial) :
 * grand titre réductible (large-title.ts), feuilles à glisser (sheets.ts),
 * menu contextuel par appui long (context-menu.ts).
 */
import { initLargeTitle } from './large-title';
import { initSheets } from './sheets';
import { initContextMenu } from './context-menu';

export function initNativeUi(): void {
  initLargeTitle();
  initSheets();
  initContextMenu();
}
