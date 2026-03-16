import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import { calibrator } from "./ydotool-calibrator.js";
import { parseShortcut } from "./keycodes.js";

const ATTACHMENTS_DIR = path.join(
  process.env.ASTRBOT_ROOT ?? process.cwd(),
  "data",
  "attachments",
);
const server = new McpServer({ name: "scroll-desktop", version: "0.4.0" });

// ── types ─────────────────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowInfo {
  id: number;
  name: string;
  app_id: string | null;
  pid: number | null;
  shell: string | null; // "xwayland" | "xdg_shell"
  rect: Rect;
  class: string | null;
  instance: string | null;
  window_role: string | null;
}

interface OutputInfo {
  name: string;
  scale: number;
  rect: Rect;
  focused: boolean;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string): {
  stdout: string;
  stderr: string;
  exit_code: number;
} {
  try {
    const stdout = execSync(cmd, { timeout: 10000 }).toString();
    return { stdout, stderr: "", exit_code: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message,
      exit_code: e.status ?? 1,
    };
  }
}

function getTree(): WindowInfo[] {
  const r = run(
    `scrollmsg -t get_tree | jq '[.. | select(.pid? and .visible?) | {
      id, name, app_id, pid, shell, rect,
      class:       .window_properties.class,
      instance:    .window_properties.instance,
      window_role: .window_properties.window_role
    }]'`,
  );
  try {
    return JSON.parse(r.stdout);
  } catch {
    return [];
  }
}

// Read scale factor dynamically from scrollmsg get_outputs.
// Falls back to 1.0 if parsing fails.
function getOutputs(): OutputInfo[] {
  const r = run(
    `scrollmsg -t get_outputs | jq '[.[] | {name, scale, focused, rect: {x: .rect.x, y: .rect.y, width: .rect.width, height: .rect.height}}]'`,
  );
  try {
    return JSON.parse(r.stdout);
  } catch {
    return [];
  }
}

// Returns the scale factor for the output that contains the given logical rect.
// Falls back to the focused output, then to 1.0.
function getScaleForRect(rect: Rect): number {
  const outputs = getOutputs();
  if (!outputs.length) return 1.0;

  // Find which output contains the window's center point
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const match = outputs.find(
    (o) =>
      cx >= o.rect.x &&
      cx < o.rect.x + o.rect.width &&
      cy >= o.rect.y &&
      cy < o.rect.y + o.rect.height,
  );
  if (match) return match.scale;

  // Fall back to focused output
  const focused = outputs.find((o) => o.focused);
  return focused?.scale ?? 1.0;
}

function findWindow(by: string, value: string): WindowInfo | null {
  const num = parseInt(value, 10);
  for (const w of getTree()) {
    switch (by) {
      case "id":
        if (w.id === num) return w;
        break;
      case "pid":
        if (w.pid === num) return w;
        break;
      case "shell":
        if (w.shell === value) return w;
        break;
      case "app_id":
        if (w.app_id?.toLowerCase().includes(value.toLowerCase())) return w;
        break;
      case "name":
        if (w.name?.toLowerCase().includes(value.toLowerCase())) return w;
        break;
      case "class":
        if (w.class?.toLowerCase().includes(value.toLowerCase())) return w;
        break;
      case "instance":
        if (w.instance?.toLowerCase().includes(value.toLowerCase())) return w;
        break;
    }
  }
  return null;
}

function focusAndGetRect(w: WindowInfo): Rect {
  run(`scrollmsg '[con_id=${w.id}] focus' && sleep 0.3`);
  return getTree().find((x) => x.id === w.id)?.rect ?? w.rect;
}

function screenshotRect(rect: Rect): { buf: Buffer; filename: string } {
  const filename = `screenshot_${Date.now()}.png`;
  const dest = path.join(ATTACHMENTS_DIR, filename);
  const r = run(
    `grim -g "${rect.x},${rect.y} ${rect.width}x${rect.height}" "${dest}"`,
  );
  if (r.exit_code !== 0) throw new Error(`grim failed: ${r.stderr}`);
  return { buf: readFileSync(dest), filename };
}

function screenshotFull(): { buf: Buffer; filename: string } {
  const filename = `screenshot_full_${Date.now()}.png`;
  const dest = path.join(ATTACHMENTS_DIR, filename);
  const r = run(`grim "${dest}"`);
  if (r.exit_code !== 0) throw new Error(`grim failed: ${r.stderr}`);
  return { buf: readFileSync(dest), filename };
}

function img(buf: Buffer) {
  return {
    type: "image" as const,
    data: buf.toString("base64"),
    mimeType: "image/png",
  };
}
function txt(obj: unknown) {
  return { type: "text" as const, text: JSON.stringify(obj, null, 2) };
}

// Convert screenshot-pixel offset inside a window to absolute ydotool coords.
// grim captures at physical pixels; scrollmsg rect is in logical pixels.
// logical = physical / scale  →  physical_offset / scale = logical_offset
function toLogical(physicalOffset: number, scale: number): number {
  return Math.round(physicalOffset / scale);
}

// Convert Wayland logical coordinates to ydotool coordinates using calibration
async function toYdotoolCoords(waylandLogicalX: number, waylandLogicalY: number): Promise<{ x: number; y: number }> {
  const scale = getScaleForRect({ x: waylandLogicalX, y: waylandLogicalY, width: 0, height: 0 });
  const physicalX = Math.round(waylandLogicalX * scale);
  const physicalY = Math.round(waylandLogicalY * scale);

  // Convert physical to ydotool logical using calibration
  const ydotool = await calibrator.toLogical({ x: physicalX, y: physicalY });
  return ydotool;
}

// Move mouse to position relative to window (abstracted base function)
// Returns the ydotool coordinates that were used
async function moveMouseToWindowPosition(
  by: string,
  value: string,
  rel_x: number,
  rel_y: number
): Promise<{ x: number; y: number }> {
  const w = findWindow(by, value);
  if (!w) throw new Error(`No window matched: ${by}=${value}`);

  const rect = focusAndGetRect(w);
  const scale = getScaleForRect(rect);

  // rect is logical coords; screenshot pixels are physical.
  // Convert: logical_pos = window_origin + (physical_offset / scale)
  const waylandLogicalX = rect.x + toLogical(rel_x, scale);
  const waylandLogicalY = rect.y + toLogical(rel_y, scale);

  // Convert to ydotool coordinates using calibration
  const ydotoolCoords = await toYdotoolCoords(waylandLogicalX, waylandLogicalY);

  run(`ydotool mousemove --absolute -x ${ydotoolCoords.x} -y ${ydotoolCoords.y}`);

  return ydotoolCoords;
}

// Shared WindowQuery schema
const WindowQuery = {
  by: z
    .enum(["name", "app_id", "class", "instance", "shell", "pid", "id"])
    .describe(
      "Field to match on:\n" +
        "  name     — window title (substring)\n" +
        "  app_id   — Wayland app_id (substring)\n" +
        "  class    — WM_CLASS, use for Flatpak/XWayland apps e.g. 'jamovi' (substring)\n" +
        "  instance — WM_INSTANCE (substring)\n" +
        "  shell    — 'xwayland' or 'xdg_shell' (exact)\n" +
        "  pid      — process ID (exact number as string)\n" +
        "  id       — Scroll node id (exact number as string)",
    ),
  value: z.string().describe("Value to match against the chosen field"),
};

// ── tools ─────────────────────────────────────────────────────────────────────

server.registerTool(
  "list_windows",
  {
    title: "List Windows",
    description:
      "List all visible windows. Returns id, name, app_id, pid, shell, rect, class, instance. " +
      "Flatpak/XWayland apps have app_id=null — use 'class' or 'instance' to identify them.",
    inputSchema: {},
  },
  async () => ({ content: [txt(getTree())] }),
);

server.registerTool(
  "list_outputs",
  {
    title: "List Outputs",
    description:
      "List all connected displays with their name, scale factor, and rect. " +
      "Useful for debugging coordinate/HiDPI issues.",
    inputSchema: {},
  },
  async () => ({ content: [txt(getOutputs())] }),
);

server.registerTool(
  "focus_window",
  {
    title: "Focus Window",
    description:
      "Bring a window to the foreground without taking a screenshot. " +
      "Use this before type_text or key_shortcut when you need to ensure the right window is focused. " +
      "Returns the window's updated rect after focus (off-screen windows move on-screen).",
    inputSchema: WindowQuery,
  },
  async ({ by, value }) => {
    const w = findWindow(by, value);
    if (!w)
      return { content: [txt({ error: "No window matched", by, value })] };
    const rect = focusAndGetRect(w);
    return { content: [txt({ focused: { id: w.id, name: w.name, rect } })] };
  },
);

server.registerTool(
  "screenshot_window",
  {
    title: "Screenshot Window",
    description:
      "Focus and screenshot a window. Returns the image for analysis. " +
      "Use list_windows first to find the right 'by'+'value' combo.",
    inputSchema: WindowQuery,
  },
  async ({ by, value }) => {
    const w = findWindow(by, value);
    if (!w)
      return { content: [txt({ error: "No window matched", by, value })] };
    try {
      const rect = focusAndGetRect(w);
      const scale = getScaleForRect(rect);
      const { buf, filename } = screenshotRect(rect);
      return {
        content: [
          img(buf),
          txt({ window: { id: w.id, name: w.name, rect }, scale, filename }),
          {
            type: "text" as const,
            text: "Describe what you see in plain text. Do NOT use markdown image syntax or file:// links.",
          },
        ],
      };
    } catch (e: any) {
      return { content: [txt({ error: e.message })] };
    }
  },
);

server.registerTool(
  "screenshot_full",
  {
    title: "Screenshot Full Desktop",
    description:
      "Screenshot the entire desktop. Returns the image for analysis.",
    inputSchema: {},
  },
  async () => {
    try {
      const { buf, filename } = screenshotFull();
      const outputs = getOutputs();
      return {
        content: [
          img(buf),
          txt({ outputs, filename }),
          {
            type: "text" as const,
            text: "Describe what you see in plain text. Do NOT use markdown image syntax or file:// links.",
          },
        ],
      };
    } catch (e: any) {
      return { content: [txt({ error: e.message })] };
    }
  },
);

server.registerTool(
  "click_in_window",
  {
    title: "Click in Window",
    description:
      "Click at a position inside a window. " +
      "rel_x/rel_y are pixel offsets from the window's top-left corner AS SEEN IN THE SCREENSHOT (physical pixels). " +
      "Scale conversion (physical → logical) is handled internally — do not compute yourself. " +
      "button: left (default) | right | double.",
    inputSchema: {
      ...WindowQuery,
      rel_x: z
        .number()
        .int()
        .describe("X pixel offset from window left edge (screenshot pixels)"),
      rel_y: z
        .number()
        .int()
        .describe("Y pixel offset from window top edge (screenshot pixels)"),
      button: z.enum(["left", "right", "double"]).default("left"),
    },
  },
  async ({ by, value, rel_x, rel_y, button }) => {
    const w = findWindow(by, value);
    if (!w)
      return { content: [txt({ error: "No window matched", by, value })] };

    const rect = focusAndGetRect(w);
    const scale = getScaleForRect(rect);

    const ydotoolCoords = await moveMouseToWindowPosition(by, value, rel_x, rel_y);

    let r;
    if (button === "right") r = run("ydotool click 0xC1");
    else if (button === "double") {
      run("ydotool click 0xC0");
      r = run("ydotool click 0xC0");
    } else r = run("ydotool click 0xC0");

    return {
      content: [
        txt({
          clicked: { ydotool_x: ydotoolCoords.x, ydotool_y: ydotoolCoords.y },
          scale,
          window: { id: w.id, name: w.name, rect },
          result: r,
        }),
      ],
    };
  },
);

server.registerTool(
  "drag_in_window",
  {
    title: "Drag in Window",
    description:
      "Click-and-drag from one position to another within a window. " +
      "Typical use: dragging variables into analysis boxes in Jamovi, moving elements in editors, etc. " +
      "All coordinates are pixel offsets from the window's top-left corner AS SEEN IN THE SCREENSHOT (physical pixels). " +
      "Scale conversion is handled internally.",
    inputSchema: {
      ...WindowQuery,
      from_x: z
        .number()
        .int()
        .describe("Drag start X (screenshot pixels from window left edge)"),
      from_y: z
        .number()
        .int()
        .describe("Drag start Y (screenshot pixels from window top edge)"),
      to_x: z
        .number()
        .int()
        .describe("Drag end X (screenshot pixels from window left edge)"),
      to_y: z
        .number()
        .int()
        .describe("Drag end Y (screenshot pixels from window top edge)"),
    },
  },
  async ({ by, value, from_x, from_y, to_x, to_y }) => {
    const w = findWindow(by, value);
    if (!w)
      return { content: [txt({ error: "No window matched", by, value })] };

    const rect = focusAndGetRect(w);
    const scale = getScaleForRect(rect);

    const startYdool = await moveMouseToWindowPosition(by, value, from_x, from_y);
    const endYdool = await moveMouseToWindowPosition(by, value, to_x, to_y);

    run("ydotool click 0x40"); // mousedown
    run("sleep 0.1");
    run(`ydotool mousemove --absolute -x ${endYdool.x} -y ${endYdool.y}`);
    run("sleep 0.1");
    const r = run("ydotool click 0x80"); // mouseup

    return {
      content: [
        txt({
          dragged: {
            from: { ydotool_x: startYdool.x, ydotool_y: startYdool.y },
            to: { ydotool_x: endYdool.x, ydotool_y: endYdool.y },
          },
          scale,
          window: { id: w.id, name: w.name, rect },
          result: r,
        }),
      ],
    };
  },
);

server.registerTool(
  "move_mouse_in_window",
  {
    title: "Move Mouse in Window",
    description:
      "Move mouse cursor to a position inside a window without clicking. " +
      "rel_x/rel_y are pixel offsets from the window's top-left corner AS SEEN IN THE SCREENSHOT (physical pixels). " +
      "Scale conversion (physical → logical) is handled internally.",
    inputSchema: {
      ...WindowQuery,
      rel_x: z
        .number()
        .int()
        .describe("X pixel offset from window left edge (screenshot pixels)"),
      rel_y: z
        .number()
        .int()
        .describe("Y pixel offset from window top edge (screenshot pixels)"),
    },
  },
  async ({ by, value, rel_x, rel_y }) => {
    try {
      const ydotoolCoords = await moveMouseToWindowPosition(by, value, rel_x, rel_y);

      return {
        content: [
          txt({
            moved_to: { ydotool_x: ydotoolCoords.x, ydotool_y: ydotoolCoords.y },
            input: { by, value, rel_x, rel_y },
          }),
        ],
      };
    } catch (e: any) {
      return { content: [txt({ error: e.message })] };
    }
  },
);

server.registerTool(
  "scroll_in_window",
  {
    title: "Scroll in Window",
    description:
      "Scroll up or down inside a window. Moves mouse to the given position first. " +
      "rel_x/rel_y are screenshot pixels from window top-left. direction: up | down. " +
      "clicks: number of scroll notches (default 3).",
    inputSchema: {
      ...WindowQuery,
      rel_x: z
        .number()
        .int()
        .describe("X position to scroll at (screenshot pixels)"),
      rel_y: z
        .number()
        .int()
        .describe("Y position to scroll at (screenshot pixels)"),
      direction: z.enum(["up", "down"]).default("down"),
      clicks: z.number().int().min(1).max(20).default(3),
    },
  },
  async ({ by, value, rel_x, rel_y, direction, clicks }) => {
    const w = findWindow(by, value);
    if (!w)
      return { content: [txt({ error: "No window matched", by, value })] };

    const rect = focusAndGetRect(w);
    const scale = getScaleForRect(rect);

    const ydotoolCoords = await moveMouseToWindowPosition(by, value, rel_x, rel_y);

    // 0xC3 = scroll up, 0xC4 = scroll down
    const btn = direction === "up" ? "0xC3" : "0xC4";
    let last;
    for (let i = 0; i < clicks; i++) {
      last = run(`ydotool click ${btn}`);
    }

    return {
      content: [
        txt({
          scrolled: { direction, clicks, at: { ydotool_x: ydotoolCoords.x, ydotool_y: ydotoolCoords.y } },
          scale,
          result: last,
        }),
      ],
    };
  },
);

server.registerTool(
  "type_text",
  {
    title: "Type Text",
    description: "Type text into the currently focused element.",
    inputSchema: {
      text: z.string().describe("Text to type"),
    },
  },
  async ({ text }) => {
    const safe = text.replace(/'/g, "'\\''");
    return { content: [txt(run(`ydotool type --delay 20 '${safe}'`))] };
  },
);

server.registerTool(
  "key_shortcut",
  {
    title: "Key Shortcut",
    description:
      "Send a keyboard shortcut. " +
      "Supports human-readable shortcuts like 'CTRL+S', 'CTRL+SHIFT+C', 'ALT+TAB', 'SUPER+ENTER'. " +
      "Separate multiple keys with '+'. Modifiers: CTRL, SHIFT, ALT, SUPER/WIN/META. " +
      "Examples: 'CTRL+C', 'CTRL+SHIFT+T', 'ALT+F4', 'SUPER+D'. " +
      "For advanced usage, you can still use the raw 'keys' parameter with keycode arrays.",
    inputSchema: {
      shortcut: z
        .string()
        .optional()
        .describe("Human-readable shortcut string (e.g., 'CTRL+S', 'CTRL+SHIFT+C')"),
      keys: z
        .array(z.array(z.number().int()))
        .optional()
        .describe("[[keycode, action], ...] action: 1=press 0=release (advanced)"),
      ctrl_c: z
        .boolean()
        .default(false)
        .describe("Send Ctrl+C safely (avoids SIGINT race)"),
    },
  },
  async ({ shortcut, keys, ctrl_c }) => {
    // Handle special Ctrl+C case
    if (ctrl_c)
      return {
        content: [
          txt(
            run(
              "sh -c 'sleep 0.1 && ydotool key 46:0 29:0' & ydotool key 29:1 46:1",
            ),
          ),
        ],
      };

    // Parse human-readable shortcut
    if (shortcut) {
      const result = parseShortcut(shortcut);
      if (result.error) {
        return { content: [txt({ error: result.error, input: shortcut })] };
      }
      return {
        content: [
          txt({
            shortcut,
            command: `ydotool key ${result.keys}`,
            result: run(`ydotool key ${result.keys}`),
          }),
        ],
      };
    }

    // Fall back to raw keycode array
    if (!keys?.length) return { content: [txt({ error: "no keys provided" })] };
    return {
      content: [
        txt(run(`ydotool key ${keys.map(([k, a]) => `${k}:${a}`).join(" ")}`)),
      ],
    };
  },
);

// ── main ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
