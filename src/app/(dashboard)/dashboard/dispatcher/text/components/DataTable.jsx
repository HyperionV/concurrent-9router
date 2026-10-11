"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * Dense sortable table.
 * @param {object} props
 * @param {Array<{key: string, label: string, align?: "left"|"right", sortValue?: (row) => number|string, render: (row) => any, title?: string}>} props.columns
 * @param {Array<object>} props.rows
 * @param {(row) => string} props.rowKey
 * @param {string} props.defaultSort column key, sorted descending first
 * @param {(row) => any} [props.renderExpanded] detail row shown when a row is clicked
 */
export default function DataTable({ columns, rows, rowKey, defaultSort, renderExpanded, empty }) {
  const [sort, setSort] = useState({ key: defaultSort, dir: "desc" });
  const [expanded, setExpanded] = useState(null);

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sort.key);
    if (!column?.sortValue) return rows;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = column.sortValue(a);
      const vb = column.sortValue(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return (va > vb ? 1 : -1) * factor;
    });
  }, [rows, columns, sort]);

  const onSort = (key) =>
    setSort((current) =>
      current.key === key ? { key, dir: current.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" },
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-border text-[11px] text-text-muted">
            {columns.map((column) => {
              const active = sort.key === column.key;
              const Icon = sort.dir === "asc" ? ChevronUp : ChevronDown;
              return (
                <th
                  key={column.key}
                  scope="col"
                  title={column.title}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={`whitespace-nowrap px-2 pb-2 font-medium ${column.align === "right" ? "text-right" : ""}`}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      onClick={() => onSort(column.key)}
                      className={`inline-flex items-center gap-0.5 hover:text-text-main ${active ? "text-text-main" : ""}`}
                    >
                      {column.label}
                      <Icon className={`h-3 w-3 ${active ? "opacity-100" : "opacity-0"}`} aria-hidden />
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-2 py-8 text-center text-text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const key = rowKey(row);
              const isOpen = expanded === key;
              return (
                <Fragment key={key}>
                  <tr
                    onClick={renderExpanded ? () => setExpanded(isOpen ? null : key) : undefined}
                    className={`border-b border-border/60 transition-colors hover:bg-[var(--row-hover)] ${renderExpanded ? "cursor-pointer" : ""}`}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={`num whitespace-nowrap px-2 py-2 ${column.align === "right" ? "text-right" : ""}`}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-border/60 bg-[var(--panel-inset)]">
                      <td colSpan={columns.length} className="px-3 py-2.5">
                        {renderExpanded(row)}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
