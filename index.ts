import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { readFileSync } from "fs";

const server = new McpServer({ name: "scroll-desktop", version: "0.3.0" });

// ── types ─────────────────────────────────────────────────────────────────────

interface Rect { x: number; y: number; width: number; height: number }

interface WindowInfo {
  id: number;
  name: string;
  app_id: string | null;
  pid: number | null;
  shell: string | null;  // "xwayland" | "xdg_shell"
  rect: Rect;
  class: string | null;
  instance: string | null;
  window_role: string | null;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string): { stdout: string; stderr: string; exit_code: number } {
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
    }]'`
  );
  try { return JSON.parse(r.stdout); } catch { return []; }
}

/**
 * WindowQuery: find a window by { by, value }.
 * by:    "name"     — substring match on window title
 *        "app_id"   — substring match on app_id (Wayland native)
 *        "class"    — substring match on WM_CLASS (XWayland / Flatpak, e.g. "jamovi")
 *        "instance" — substring match on WM_INSTANCE
 *        "shell"    — exact match: "xwayland" | "xdg_shell"
 *        "pid"      — exact numeric match
 *        "id"       — exact Scroll node id
 */
function findWindow(by: string, value: string): WindowInfo | null {
  const num = parseInt(value, 10);
  for (const w of getTree()) {
    switch (by) {
      case "id":       if (w.id       === num)                                         return w; break;
      case "pid":      if (w.pid      === num)                                         return w; break;
      case "shell":    if (w.shell    === value)                                       return w; break;
      case "app_id":   if (w.app_id?.toLowerCase().includes(value.toLowerCase()))     return w; break;
      case "name":     if (w.name?.toLowerCase().includes(value.toLowerCase()))       return w; break;
      case "class":    if (w.class?.toLowerCase().includes(value.toLowerCase()))      return w; break;
      case "instance": if (w.instance?.toLowerCase().includes(value.toLowerCase()))   return w; break;
    }
  }
  return null;
}

function focusAndGetRect(w: WindowInfo): Rect {
  run(`scrollmsg '[con_id=${w.id}] focus' && sleep 0.3`);
  return getTree().find(x => x.id === w.id)?.rect ?? w.rect;
}

function screenshotRect(rect: Rect): Buffer {
  const path = "/tmp/astrbot_mcp_window.png";
  const r = run(`grim -g "${rect.x},${rect.y} ${rect.width}x${rect.height}" ${path}`);
  if (r.exit_code !== 0) throw new Error(`grim failed: ${r.stderr}`);
  return readFileSync(path);
}

function img(buf: Buffer) {
  return { type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" };
}
function txt(obj: unknown) {
  return { type: "text" as const, text: JSON.stringify(obj, null, 2) };
}

// Shared WindowQuery schema used by every window-targeting tool
const WindowQuery = {
  by: z.enum(["name", "app_id", "class", "instance", "shell", "pid", "id"]).describe(
    "Field to match on:\n" +
    "  name     — window title (substring)\n" +
    "  app_id   — Wayland app_id (substring)\n" +
    "  class    — WM_CLASS, use for Flatpak/XWayland apps e.g. 'jamovi' (substring)\n" +
    "  instance — WM_INSTANCE (substring)\n" +
    "  shell    — 'xwayland' or 'xdg_shell' (exact)\n" +
    "  pid      — process ID (exact number as string)\n" +
    "  id       — Scroll node id (exact number as string)"
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
  async () => ({ content: [txt(getTree())] })
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
    if (!w) return { content: [txt({ error: "No window matched", by, value })] };
    const rect = focusAndGetRect(w);
    return { content: [txt({ focused: { id: w.id, name: w.name, rect } })] };
  }
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
    if (!w) return { content: [txt({ error: "No window matched", by, value })] };
    try {
      const rect = focusAndGetRect(w);
      return { content: [img(screenshotRect(rect))] };
    } catch (e: any) {
      return { content: [txt({ error: e.message })] };
    }
  }
);

server.registerTool(
  "screenshot_full",
  {
    title: "Screenshot Full Desktop",
    description: "Screenshot the entire desktop. Returns the image for analysis.",
    inputSchema: {},
  },
  async () => {
    const path = "/tmp/astrbot_mcp_full.png";
    const r = run(`grim ${path}`);
    if (r.exit_code !== 0) return { content: [txt({ error: r.stderr })] };
    return { content: [img(readFileSync(path))] };
  }
);

server.registerTool(
  "click_in_window",
  {
    title: "Click in Window",
    description:
      "Click at a position inside a window. " +
      "rel_x/rel_y are pixel offsets from the window's top-left corner AS SEEN IN THE SCREENSHOT. " +
      "All coordinate math (window origin + HiDPI ÷2) is handled internally — do not compute yourself. " +
      "button: left (default) | right | double.",
    inputSchema: {
      ...WindowQuery,
      rel_x:  z.number().int().describe("X pixel offset from window left edge (screenshot pixels)"),
      rel_y:  z.number().int().describe("Y pixel offset from window top edge (screenshot pixels)"),
      button: z.enum(["left", "right", "double"]).default("left"),
    },
  },
  async ({ by, value, rel_x, rel_y, button }) => {
    const w = findWindow(by, value);
    if (!w) return { content: [txt({ error: "No window matched", by, value })] };

    const rect = focusAndGetRect(w);

    // rect is in logical coords; grim screenshots are 2× (HiDPI scale=2)
    // rel_x/rel_y are screenshot pixels within the window
    // ydotool coord = logical window origin + screenshot_offset / 2
    const tx = rect.x + Math.floor(rel_x / 2);
    const ty = rect.y + Math.floor(rel_y / 2);

    run(`ydotool mousemove --absolute -x ${tx} -y ${ty}`);

    let r;
    if (button === "right")       r = run("ydotool click 0xC1");
    else if (button === "double") { run("ydotool click 0xC0"); r = run("ydotool click 0xC0"); }
    else                          r = run("ydotool click 0xC0");

    return { content: [txt({ clicked: { ydotool_x: tx, ydotool_y: ty }, window: { id: w.id, name: w.name, rect }, result: r })] };
  }
);

server.registerTool(
  "drag_in_window",
  {
    title: "Drag in Window",
    description:
      "Click-and-drag from one position to another within a window. " +
      "Typical use: dragging variables into analysis boxes in Jamovi, moving elements in editors, etc. " +
      "All coordinates are pixel offsets from the window's top-left corner AS SEEN IN THE SCREENSHOT. " +
      "Coordinate math (window origin + HiDPI ÷2) is handled internally.",
    inputSchema: {
      ...WindowQuery,
      from_x: z.number().int().describe("Drag start X (screenshot pixels from window left edge)"),
      from_y: z.number().int().describe("Drag start Y (screenshot pixels from window top edge)"),
      to_x:   z.number().int().describe("Drag end X (screenshot pixels from window left edge)"),
      to_y:   z.number().int().describe("Drag end Y (screenshot pixels from window top edge)"),
    },
  },
  async ({ by, value, from_x, from_y, to_x, to_y }) => {
    const w = findWindow(by, value);
    if (!w) return { content: [txt({ error: "No window matched", by, value })] };

    const rect = focusAndGetRect(w);

    const sx = rect.x + Math.floor(from_x / 2);
    const sy = rect.y + Math.floor(from_y / 2);
    const ex = rect.x + Math.floor(to_x / 2);
    const ey = rect.y + Math.floor(to_y / 2);

    run(`ydotool mousemove --absolute -x ${sx} -y ${sy}`);
    run("ydotool click 0x40");           // mousedown
    run("sleep 0.1");
    run(`ydotool mousemove --absolute -x ${ex} -y ${ey}`);
    run("sleep 0.1");
    const r = run("ydotool click 0x80"); // mouseup

    return { content: [txt({
      dragged: { from: { ydotool_x: sx, ydotool_y: sy }, to: { ydotool_x: ex, ydotool_y: ey } },
      window:  { id: w.id, name: w.name, rect },
      result:  r,
    })] };
  }
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
  }
);

server.registerTool(
  "key_shortcut",
  {
    title: "Key Shortcut",
    description:
      "Send a keyboard shortcut. " +
      "Common keycodes: Enter=28 Tab=15 Escape=1 Space=57 Backspace=14 " +
      "Ctrl=29 Shift=42 Alt=56 Super=125 Up=103 Down=108 Left=105 Right=106. " +
      "Set ctrl_c=true to send Ctrl+C safely.",
    inputSchema: {
      keys:   z.array(z.tuple([z.number().int(), z.number().int()])).optional()
                .describe("[[keycode, action], ...] action: 1=press 0=release"),
      ctrl_c: z.boolean().default(false).describe("Send Ctrl+C safely (avoids SIGINT race)"),
    },
  },
  async ({ keys, ctrl_c }) => {
    if (ctrl_c)
      return { content: [txt(run("sh -c 'sleep 0.1 && ydotool key 46:0 29:0' & ydotool key 29:1 46:1"))] };
    if (!keys?.length)
      return { content: [txt({ error: "no keys provided" })] };
    return { content: [txt(run(`ydotool key ${keys.map(([k, a]) => `${k}:${a}`).join(" ")}`))] };
  }
);

// ── main ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);