export type SyncDirection = 'both' | 'left-to-right' | 'right-to-left';

type LinkEndpoint = {
  workbookId: number;
  sheetId: string;
  keyCol: number;
  valueCol: number;
};

export function buildWorkbookLink(direction: SyncDirection, left: LinkEndpoint, right: LinkEndpoint) {
  // The stored left endpoint is the source for one-way links.
  const [source, target] = direction === 'right-to-left' ? [right, left] : [left, right];
  return {
    leftWorkbookId: source.workbookId,
    leftSheetId: source.sheetId,
    leftKeyCol: source.keyCol,
    leftValueCol: source.valueCol,
    rightWorkbookId: target.workbookId,
    rightSheetId: target.sheetId,
    rightKeyCol: target.keyCol,
    rightValueCol: target.valueCol,
    bidirectional: direction === 'both',
  };
}
