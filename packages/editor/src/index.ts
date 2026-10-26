export { createEditor } from './create-editor.ts'
export type { CreateEditorOptions, EditorHandle } from './create-editor.ts'
export type { SlashState, SelectionState, ContextCallbacks } from './context.ts'
export {
  parseTable,
  serializeTable,
  createTable,
  addRow,
  removeRow,
  addColumn,
  removeColumn,
  setCell,
  cycleAlign,
} from './table-model.ts'
export type { TableModel, CellAlign } from './table-model.ts'
