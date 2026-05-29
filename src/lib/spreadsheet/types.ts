export interface TableData {
  title?: string;
  headers: string[];
  rows: string[][];
  highlight?: number[];
}

export interface SpreadsheetWorkbook {
  filename: string;
  tables: TableData[];
}
