// Linux input event keycode mappings
// Based on linux/input-event-codes.h

export const KEYCODES: Record<string, number> = {
  // Modifiers
  "CTRL": 29,
  "CONTROL": 29,
  "SHIFT": 42,
  "ALT": 56,
  "SUPER": 125,
  "WIN": 125,
  "META": 125,
  "LEFTCTRL": 29,
  "RIGHTCTRL": 97,
  "LEFTSHIFT": 42,
  "RIGHTSHIFT": 54,
  "LEFTALT": 56,
  "RIGHTALT": 100,
  "LEFTMETA": 125,
  "RIGHTMETA": 126,

  // Special keys
  "ENTER": 28,
  "RETURN": 28,
  "TAB": 15,
  "ESC": 1,
  "ESCAPE": 1,
  "SPACE": 57,
  "BACKSPACE": 14,
  "DELETE": 111,
  "DEL": 111,
  "INSERT": 110,
  "HOME": 102,
  "END": 107,

  // Arrow keys
  "UP": 103,
  "DOWN": 108,
  "LEFT": 105,
  "RIGHT": 106,
  "PAGEUP": 104,
  "PAGEDOWN": 109,
  "PRIOR": 104,
  "NEXT": 109,

  // Function keys
  "F1": 59, "F2": 60, "F3": 61, "F4": 62, "F5": 63, "F6": 64,
  "F7": 65, "F8": 66, "F9": 67, "F10": 68, "F11": 87, "F12": 88,

  // Letters
  "A": 30, "B": 48, "C": 46, "D": 32, "E": 18, "F": 33, "G": 34, "H": 35,
  "I": 23, "J": 36, "K": 37, "L": 38, "M": 50, "N": 49, "O": 24, "P": 25,
  "Q": 16, "R": 19, "S": 31, "T": 20, "U": 22, "V": 47, "W": 17, "X": 45,
  "Y": 21, "Z": 44,

  // Numbers (top row)
  "0": 11, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10,

  // Symbols
  "MINUS": 12, "EQUAL": 13, "EQUALS": 13,
  "LEFTBRACE": 26, "LEFTBRACKET": 26,
  "RIGHTBRACE": 27, "RIGHTBRACKET": 27,
  "BACKSLASH": 43,
  "SEMICOLON": 39,
  "APOSTROPHE": 39,
  "GRAVE": 41, "BACKTICK": 41,
  "COMMA": 51,
  "DOT": 52, "PERIOD": 52,
  "SLASH": 53, "FORWARD SLASH": 53,

  // Lock keys
  "CAPSLOCK": 58, "CAPS": 58,
  "NUMLOCK": 69, "NUM": 69,
  "SCROLLLOCK": 70,

  // Other special keys
  "PRINT": 210, "PRINTSCREEN": 210,
  "PAUSE": 119, "BREAK": 119,
  "MENU": 139,
  "CONTEXTMENU": 139,
  "HELP": 138,

  // Media keys
  "MUTE": 113,
  "VOLUMEDOWN": 114,
  "VOLUMEUP": 115,
  "PLAYPAUSE": 164,
  "NEXTSONG": 163,
  "PREVIOUSSONG": 165,

  // Numpad
  "KP0": 82, "KP1": 79, "KP2": 80, "KP3": 81, "KP4": 75, "KP5": 76,
  "KP6": 77, "KP7": 71, "KP8": 72, "KP9": 73,
  "KPDOT": 83, "KPPERIOD": 83,
  "KPENTER": 96,
  "KPPLUS": 78, "KPMINUS": 74,
  "KPMULTIPLY": 55, "KPASTERISK": 55,
  "KPSLASH": 98,
};

// Case-insensitive lookup
export function getKeycode(name: string): number | undefined {
  return KEYCODES[name.toUpperCase()];
}

// Parse a key sequence string into ydotool key commands
// Format: "CTRL+S", "CTRL+SHIFT+C", "ALT+TAB", etc.
// Handles case-insensitive input and extra spaces: "Ctrl + Shift + a"
export function parseShortcut(shortcut: string): { keys: string; error?: string } {
  // Trim and check for empty input
  const trimmed = shortcut.trim();
  if (!trimmed) {
    return { keys: '', error: 'Empty shortcut - please provide a key combination' };
  }

  // Split by '+', trim each part, and convert to uppercase
  const parts = trimmed.split('+').map(s => s.trim().toUpperCase());

  // Filter out empty parts (from inputs like "+++" or "A++B")
  const validParts = parts.filter(p => p.length > 0);

  if (validParts.length === 0) {
    return { keys: '', error: 'No valid keys found - check your shortcut format' };
  }

  const modifiers: number[] = [];
  const finalKey: number[] = [];

  // Separate modifiers from final key
  for (const part of validParts) {
    const keycode = getKeycode(part);
    if (keycode === undefined) {
      return { keys: '', error: `Unknown key: "${part}" - check spelling or use a different key name` };
    }

    // Check if this is a modifier
    const isModifier = [
      'CTRL', 'CONTROL', 'SHIFT', 'ALT', 'SUPER', 'WIN', 'META',
      'LEFTCTRL', 'RIGHTCTRL', 'LEFTSHIFT', 'RIGHTSHIFT',
      'LEFTALT', 'RIGHTALT', 'LEFTMETA', 'RIGHTMETA'
    ].includes(part);

    if (isModifier) {
      modifiers.push(keycode);
    } else {
      finalKey.push(keycode);
    }
  }

  if (finalKey.length === 0 && modifiers.length > 0) {
    // Shortcut is just modifiers (e.g., "CTRL"), use it as final key
    finalKey.push(...modifiers);
    modifiers.length = 0;
  }

  if (finalKey.length === 0) {
    return { keys: '', error: 'Invalid shortcut - must contain at least one non-modifier key' };
  }

  // Build the key sequence:
  // 1. Press all modifiers
  // 2. Press final key(s)
  // 3. Release final key(s)
  // 4. Release modifiers

  const sequence: string[] = [];

  // Press modifiers
  for (const code of modifiers) {
    sequence.push(`${code}:1`);
  }

  // Press final key(s)
  for (const code of finalKey) {
    sequence.push(`${code}:1`);
  }

  // Release final key(s) in reverse order
  for (let i = finalKey.length - 1; i >= 0; i--) {
    sequence.push(`${finalKey[i]}:0`);
  }

  // Release modifiers in reverse order
  for (let i = modifiers.length - 1; i >= 0; i--) {
    sequence.push(`${modifiers[i]}:0`);
  }

  return { keys: sequence.join(' ') };
}
