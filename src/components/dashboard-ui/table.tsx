import type { ReactNode } from "react";

type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
};

type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
};

export function DataTable<T>({ columns, rows, getRowKey, onRowClick }: DataTableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-xl border border-bb-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-bb-border bg-bb-navy-2">
            {columns.map((column) => (
              <th key={column.header} className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-bb-text-3">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={getRowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-bb-border/50 last:border-0 ${onRowClick ? "cursor-pointer transition-colors hover:bg-white/3" : ""}`}
            >
              {columns.map((column) => (
                <td key={column.header} className="whitespace-nowrap px-4 py-3 text-bb-text-2">
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
