export type Selection<T> = { kind: "caret"; at: T } | { kind: "range"; anchor: T; head: T };

export type BookPlace =
  | { kind: "manuscript" }
  | { kind: "reading"; groupId: string }
  | { kind: "body"; file: string; nodeId: string; selection: Selection<number> }
  | { kind: "title"; file: "book.yaml"; selection: Selection<number> };

export function manuscriptPlace(): Extract<BookPlace, { kind: "manuscript" }> {
  return { kind: "manuscript" };
}

export function readingPlace(groupId: string): Extract<BookPlace, { kind: "reading" }> {
  return { kind: "reading", groupId };
}

export function bodyPlace(
  file: string,
  nodeId: string,
  body: string,
  anchor: number,
  head: number,
): Extract<BookPlace, { kind: "body" }> {
  return {
    kind: "body",
    file: relativeFile(file),
    nodeId,
    selection: numberSelection(body, anchor, head),
  };
}

export function titlePlace(title: string, anchor: number, head: number): Extract<BookPlace, { kind: "title" }> {
  return { kind: "title", file: "book.yaml", selection: numberSelection(title, anchor, head) };
}

export function bookRelative(root: string, path: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) throw new Error("place file is outside the book.");
  return path.slice(prefix.length);
}

export function encodePlace(place: BookPlace): string {
  return JSON.stringify(place);
}

export function parsePlace(json: string): BookPlace {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("place.json is not JSON.");
  }
  return readPlace(value);
}

export function createPlaceWriter(
  write: (json: string) => Promise<void>,
  clear: () => Promise<void>,
): { submit(place: BookPlace | null): void } {
  let flight: Promise<void> = Promise.resolve();
  let pending: BookPlace | null | undefined;
  let queued = false;
  const pump = (): void => {
    if (pending === undefined) return;
    const next = pending;
    pending = undefined;
    flight = flight
      .then(() => (next === null ? clear() : write(encodePlace(next))))
      .then(pump, pump);
  };
  return {
    submit(place) {
      pending = place;
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        pump();
      });
    },
  };
}

function numberSelection(text: string, anchor: number, head: number): Selection<number> {
  const start = codePointOf(text, anchor);
  const end = codePointOf(text, head);
  if (anchor === head || start === end) return { kind: "caret", at: start };
  return { kind: "range", anchor: start, head: end };
}

function readPlace(value: unknown): BookPlace {
  const record = recordOf(value, "place.json");
  if (record.kind === "manuscript") return readBare(record, { kind: "manuscript" });
  if (record.kind === "reading") return readReading(record);
  if (record.kind === "body") return readBody(record);
  if (record.kind === "title") return readTitle(record);
  throw new Error("place.json kind is not a book place.");
}

function readBare(record: Record<string, unknown>, place: BookPlace): BookPlace {
  if ("file" in record || "selection" in record) throw new Error("place.json has no file and no caret.");
  return place;
}

function readReading(record: Record<string, unknown>): BookPlace {
  if ("file" in record || "selection" in record) throw new Error("place.json has no file and no caret.");
  if (typeof record.groupId !== "string" || record.groupId.length === 0) {
    throw new Error("place.json group is missing.");
  }
  return { kind: "reading", groupId: record.groupId };
}

function readBody(record: Record<string, unknown>): BookPlace {
  if (typeof record.file !== "string" || typeof record.nodeId !== "string") {
    throw new Error("place.json body is missing a file.");
  }
  return {
    kind: "body",
    file: relativeFile(record.file),
    nodeId: record.nodeId,
    selection: readNumberSelection(record.selection),
  };
}

function readTitle(record: Record<string, unknown>): BookPlace {
  if (record.file !== "book.yaml") throw new Error("place.json title file is not book.yaml.");
  return { kind: "title", file: "book.yaml", selection: readNumberSelection(record.selection) };
}

function readNumberSelection(value: unknown): Selection<number> {
  const record = recordOf(value, "place.json selection");
  if (record.kind === "caret") return { kind: "caret", at: readCount(record.at) };
  if (record.kind === "range") {
    const anchor = readCount(record.anchor);
    const head = readCount(record.head);
    if (anchor === head) throw new Error("place.json range ends are equal.");
    return { kind: "range", anchor, head };
  }
  throw new Error("place.json selection kind is not caret or range.");
}

function relativeFile(file: string): string {
  if (file.startsWith("/") || file.split("/").includes("..") || file.split("/").includes("")) {
    throw new Error("place.json file is not inside the book.");
  }
  return file;
}

function readCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("place.json offset is not a whole number.");
  }
  return value;
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePointOf(text: string, utf16: number): number {
  let end = Math.max(0, Math.min(utf16, text.length));
  if (splitsPair(text, end)) end -= 1;
  let seen = 0;
  let index = 0;
  while (index < end) {
    index += pairWidth(text, index);
    seen += 1;
  }
  return seen;
}

function splitsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const prev = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

function pairWidth(text: string, index: number): number {
  const point = text.codePointAt(index);
  if (point === undefined) return 1;
  return point > 0xffff ? 2 : 1;
}
