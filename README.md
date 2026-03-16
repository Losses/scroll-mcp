# Scroll MCP

A Model Context Protocol (MCP) server that enables AI agents to perform desktop automation on [Scroll](https://github.com/dawsers/scroll), a Wayland compositor. This server integrates with [AstrBot](https://github.com/AstrBotDevs/AstrBot) to provide powerful window management, screenshot, mouse, and keyboard control capabilities.

## Features

- **Window Management**: List, focus, and manipulate windows by various attributes (name, app_id, class, pid, id)
- **Screenshots**: Capture full desktop or specific windows with automatic HiDPI scale handling
- **Mouse Control**: Click, drag, scroll, and move mouse with coordinate translation
- **Keyboard Input**: Type text and send keyboard shortcuts
- **Smart Calibration**: Automatic coordinate system calibration for accurate mouse positioning across different DPI scales
- **Flatpak/XWayland Support**: Special handling for Flatpak and XWayland applications via WM_CLASS matching

## Requirements

- **Scroll**: A Wayland compositor (`scrollmsg` CLI tool must be available)
- **ydotool**: Linux command-line automation tool (daemon must be running)
- **grim**: Screenshot utility for Wayland
- **jq**: JSON processor for parsing scrollmsg output
- **wl-find-cursor**: Tool for reading cursor position (for calibration)
- **Bun**: JavaScript runtime and package manager

### NixOS Users

If you're on NixOS, refer to [astrbot.service.example](./astrbot.service.example) for systemd service configuration.

## Installation

```bash
# Install dependencies
bun install
```

## Usage

### Running the Server

```bash
bun run index.ts
```

### Integrating with Astrbot

Configure Astrbot to use this MCP server. The server communicates via stdio using the Model Context Protocol.

## Environment Variables

- `ASTRBOT_ROOT`: Root directory for Astrbot (default: current working directory)
- Attachments are saved to `$ASTRBOT_ROOT/data/attachments/`
