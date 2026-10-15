import { describe, expect, it } from "vitest";
import { bodyPlace, bookRelative, encodePlace, manuscriptPlace, parsePlace, readingPlace } from "./place";

describe("book place", () => {
  it("records a path relative to the book folder", () => {
    expect(bookRelative("/books/naming", "/books/naming/manuscript/010-inward.md")).toBe(
      "manuscript/010-inward.md",
    );
    expect(() => bookRelative("/books/naming", "/other/manuscript/010-inward.md")).toThrow(/outside/);
  });

  it("records the manuscript row with no file", () => {
    expect(encodePlace(manuscriptPlace())).toBe('{"kind":"manuscript"}');
    expect(() => parsePlace('{"kind":"manuscript","file":"book.yaml"}')).toThrow(/no file/);
  });

  it("records a group reading view with no file", () => {
    expect(encodePlace(readingPlace("naming"))).toBe('{"kind":"reading","groupId":"naming"}');
    expect(() => parsePlace('{"kind":"reading","groupId":"naming","selection":{"kind":"caret","at":0}}')).toThrow(
      /no file/,
    );
  });

  it("records a caret at the first body character", () => {
    const place = bodyPlace("manuscript/020-naming/010-inward.md", "inward", "Hello", 0, 0);
    expect(encodePlace(place)).toBe(
      '{"kind":"body","file":"manuscript/020-naming/010-inward.md","nodeId":"inward","selection":{"kind":"caret","at":0}}',
    );
  });

  it("records a selection and collapses a caret", () => {
    expect(bodyPlace("manuscript/010-a.md", "a", "Hello", 1, 4).selection).toEqual({
      kind: "range",
      anchor: 1,
      head: 4,
    });
    expect(bodyPlace("manuscript/010-a.md", "a", "Hello", 2, 2).selection).toEqual({ kind: "caret", at: 2 });
  });

  it("rejects a range whose ends are equal and a path that escapes the book", () => {
    expect(() =>
      parsePlace(
        '{"kind":"body","file":"manuscript/010-a.md","nodeId":"a","selection":{"kind":"range","anchor":1,"head":1}}',
      ),
    ).toThrow(/equal/);
    expect(() =>
      parsePlace(
        '{"kind":"body","file":"../secret.md","nodeId":"a","selection":{"kind":"caret","at":0}}',
      ),
    ).toThrow(/inside the book/);
  });
});
