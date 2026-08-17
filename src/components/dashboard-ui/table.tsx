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
    <div className="bb-shadow-card overflow-hidden rounded-3xl bg-bb-navy-2">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header} className="whitespace-nowrap px-6 py-3 text-left text-xs font-medium text-bb-text-3">
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
              className={`border-t border-bb-navy-3 ${onRowClick ? "cursor-pointer transition-colors hover:bg-bb-navy-3" : ""}`}
            >
              {columns.map((column) => (
                <td key={column.header} className="whitespace-nowrap px-6 py-3.5 text-bb-text-2">
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
