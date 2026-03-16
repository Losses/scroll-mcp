import { test, expect } from "bun:test";
import { getKeycode, parseShortcut } from "./keycodes";

test("getKeycode finds basic keys", () => {
  expect(getKeycode("ENTER")).toBe(28);
  expect(getKeycode("enter")).toBe(28); // case insensitive
  expect(getKeycode("EnTeR")).toBe(28); // mixed case
  expect(getKeycode("CTRL")).toBe(29);
  expect(getKeycode("control")).toBe(29); // alias
  expect(getKeycode("SHIFT")).toBe(42);
  expect(getKeycode("A")).toBe(30);
  expect(getKeycode("F1")).toBe(59);
});

test("parseShortcut handles case-insensitive input", () => {
  expect(parseShortcut("ctrl+c").error).toBeUndefined();
  expect(parseShortcut("CTRL+C").error).toBeUndefined();
  expect(parseShortcut("Ctrl+C").error).toBeUndefined();
  expect(parseShortcut("cTrL+c").error).toBeUndefined();
});

test("parseShortcut handles extra spaces", () => {
  expect(parseShortcut("CTRL + SHIFT + A").error).toBeUndefined();
  expect(parseShortcut("  CTRL+S  ").error).toBeUndefined();
  expect(parseShortcut("CTRL   +   S").error).toBeUndefined();
});

test("parseShortcut handles simple shortcuts", () => {
  const result = parseShortcut("CTRL+C");
  expect(result.error).toBeUndefined();
  expect(result.keys).toContain("29:1"); // CTRL press
  expect(result.keys).toContain("46:1"); // C press
  expect(result.keys).toContain("46:0"); // C release
  expect(result.keys).toContain("29:0"); // CTRL release
});

test("parseShortcut handles multi-key shortcuts", () => {
  const result = parseShortcut("CTRL+SHIFT+T");
  expect(result.error).toBeUndefined();
  expect(result.keys).toContain("29:1"); // CTRL press
  expect(result.keys).toContain("42:1"); // SHIFT press
  expect(result.keys).toContain("20:1"); // T press
});

test("parseShortcut handles various formats", () => {
  expect(parseShortcut("ALT+TAB").error).toBeUndefined();
  expect(parseShortcut("SUPER+D").error).toBeUndefined();
  expect(parseShortcut("WIN+D").error).toBeUndefined(); // WIN alias
  expect(parseShortcut("CTRL+ALT+DELETE").error).toBeUndefined();
  expect(parseShortcut("SHIFT+HOME").error).toBeUndefined();
});

test("parseShortcut handles unknown keys with clear error", () => {
  const result = parseShortcut("CTRL+UNKNOWN");
  expect(result.error).toBeDefined();
  expect(result.error).toContain("UNKNOWN");
  expect(result.error).toContain("check spelling");
});

test("parseShortcut handles empty string with clear error", () => {
  const result = parseShortcut("");
  expect(result.error).toBeDefined();
  expect(result.error).toContain("Empty shortcut");
});

test("parseShortcut handles only plus signs", () => {
  const result = parseShortcut("+++");
  expect(result.error).toBeDefined();
  expect(result.error).toContain("No valid keys");
});

test("parseShortcut handles only spaces", () => {
  const result = parseShortcut("   ");
  expect(result.error).toBeDefined();
  expect(result.error).toContain("Empty shortcut");
});

test("parseShortcut handles modifier-only", () => {
  const result = parseShortcut("CTRL");
  expect(result.error).toBeUndefined();
  // Should just press and release CTRL
  expect(result.keys).toContain("29:1");
  expect(result.keys).toContain("29:0");
});

test("parseShortcut uses different modifier names", () => {
  expect(parseShortcut("CONTROL+S").error).toBeUndefined(); // CONTROL alias
  expect(parseShortcut("META+ENTER").error).toBeUndefined(); // META alias
  expect(parseShortcut("WIN+D").error).toBeUndefined(); // WIN alias
});
