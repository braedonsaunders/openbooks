// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * A minimal deterministic XML writer for e-invoice documents.
 *
 * Elements are built as a tree, then serialised with a UTF-8 declaration
 * and two-space indentation. Optional content is dropped at construction:
 * a leaf whose value is null or blank, and a container left with no
 * children, both disappear, because Peppol (PEPPOL-EN16931-R008) and good
 * practice forbid empty elements. Containers the schema makes mandatory are
 * built with `required`, which survives empty.
 */

export type XmlAttributes = Readonly<Record<string, string | null | undefined>>;
export type XmlChild = XmlElement | null | undefined | false;

export interface XmlElement {
  readonly name: string;
  readonly attributes: XmlAttributes;
  readonly text: string | null;
  readonly children: readonly XmlElement[];
}

function present(children: readonly XmlChild[]): XmlElement[] {
  return children.filter((child): child is XmlElement => Boolean(child));
}

/** A container; null when none of its children survived. */
export function el(name: string, ...children: XmlChild[]): XmlElement | null {
  return elWith(name, {}, ...children);
}

/** A container with attributes; null when none of its children survived. */
export function elWith(name: string, attributes: XmlAttributes, ...children: XmlChild[]): XmlElement | null {
  const kept = present(children);
  return kept.length === 0 ? null : { name, attributes, text: null, children: kept };
}

/** A container the schema requires even when it has no children. */
export function required(name: string, attributes: XmlAttributes, ...children: XmlChild[]): XmlElement {
  return { name, attributes, text: null, children: present(children) };
}

/** A text leaf; null when the value is null, undefined or blank. */
export function leaf(name: string, value: string | null | undefined, attributes: XmlAttributes = {}): XmlElement | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  return { name, attributes, text: value, children: [] };
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(value: string): string {
  assertXmlCharacters(value);
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

/** XML 1.0 cannot represent control characters, surrogate code points or noncharacters. */
export function assertXmlCharacters(value: string): void {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (!(code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) {
      throw new Error("The XML contains a character that XML 1.0 cannot represent.");
    }
  }
}

function attributeText(attributes: XmlAttributes): string {
  return Object.entries(attributes)
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined && entry[1] !== "")
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
}

function write(node: XmlElement, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  const open = `${node.name}${attributeText(node.attributes)}`;
  if (node.text !== null) {
    out.push(`${indent}<${open}>${escapeXml(node.text)}</${node.name}>`);
  } else if (node.children.length === 0) {
    out.push(`${indent}<${open}/>`);
  } else {
    out.push(`${indent}<${open}>`);
    for (const child of node.children) write(child, depth + 1, out);
    out.push(`${indent}</${node.name}>`);
  }
}

/** Serialise a document: UTF-8 declaration, two-space indentation, trailing newline. */
export function serializeXml(root: XmlElement): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  write(root, 0, out);
  return `${out.join("\n")}\n`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as ISO `YYYY-MM-DD`. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** An ISO date for UBL, refusing anything that is not one. */
export function isoDate(value: string, term: string): string {
  if (!isIsoDate(value)) throw new Error(`${term} must be an ISO date (YYYY-MM-DD), saw "${value}"`);
  return value;
}

/** An ISO date in UN/CEFACT format 102 (`YYYYMMDD`) for CII. */
export function format102(value: string, term: string): string {
  return isoDate(value, term).replaceAll("-", "");
}
