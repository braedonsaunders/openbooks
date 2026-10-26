"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";

export interface BomRevisionDiffRow {
  key: string;
  kind: "added" | "removed" | "changed" | "unchanged";
  kindLabel: string;
  /** One display value per data column; the change kind is rendered last. */
  cells: string[];
}

/** The recipe diff table. Unchanged components stay hidden until the reader asks for them. */
export function BomRevisionDiffTable({
  headers,
  rows,
  unchangedCount,
  showUnchangedLabel,
  hideUnchangedLabel,
  emptyLabel,
}: {
  /** Column headings in display order; the last one labels the change kind. */
  headers: string[];
  rows: BomRevisionDiffRow[];
  unchangedCount: number;
  showUnchangedLabel: string;
  hideUnchangedLabel: string;
  emptyLabel: string;
}) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const visible = showUnchanged ? rows : rows.filter((row) => row.kind !== "unchanged");
  return (
    <div className="space-y-2">
      {unchangedCount > 0 ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showUnchanged}
            onClick={() => setShowUnchanged((current) => !current)}
          >
            {showUnchanged ? hideUnchangedLabel : showUnchangedLabel}
          </Button>
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            {headers.map((header, index) => (
              <TableHead key={index}>{header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.length === 0 ? (
            <TableRow>
              <TableCell colSpan={headers.length} className="text-muted-foreground">
                {emptyLabel}
              </TableCell>
            </TableRow>
          ) : (
            visible.map((row) => (
              <TableRow key={row.key}>
                {row.cells.map((cell, index) => (
                  <TableCell key={index} className="break-words align-top">
                    {cell}
                  </TableCell>
                ))}
                <TableCell>
                  <Badge
                    variant={
                      row.kind === "unchanged"
                        ? "secondary"
                        : row.kind === "removed"
                          ? "destructive"
                          : "default"
                    }
                  >
                    {row.kindLabel}
                  </Badge>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
