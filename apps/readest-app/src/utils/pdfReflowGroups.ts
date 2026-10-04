import type { ReflowBlock } from './pdfReflow';

export interface IndexedBlock {
  block: ReflowBlock;
  index: number;
}

export type ReflowGroup =
  | { type: 'table'; id: number; rows: Array<{ row: number; cells: IndexedBlock[] }> }
  | { type: 'block'; block: ReflowBlock; index: number };

/** Gather the consecutive `cell` blocks of one table into rows. Block indices
 * are preserved so speech highlights, selections and citations keep working. */
export function groupReflowBlocks(blocks: ReflowBlock[]): ReflowGroup[] {
  const groups: ReflowGroup[] = [];
  let table: Extract<ReflowGroup, { type: 'table' }> | undefined;
  blocks.forEach((block, index) => {
    if (block.kind === 'cell' && block.table) {
      if (!table || table.id !== block.table.id) {
        table = { type: 'table', id: block.table.id, rows: [] };
        groups.push(table);
      }
      let row = table.rows[table.rows.length - 1];
      if (!row || row.row !== block.table.row) {
        row = { row: block.table.row, cells: [] };
        table.rows.push(row);
      }
      row.cells.push({ block, index });
      return;
    }
    table = undefined;
    groups.push({ type: 'block', block, index });
  });
  return groups;
}
