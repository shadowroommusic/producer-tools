# ShadowRoom MCP integration

Every ShadowRoom capability is a standalone stdio MCP server. The desktop application is optional:
Codex, Claude Desktop, Cursor, Cline, Roo Code, or another MCP-compatible client can call the same
servers directly.

The machine-readable registry is [`mcp/manifest.json`](../mcp/manifest.json). It links every public
repository, entrypoint, license, and short capability description.

## Quick start

Clone the ecosystem next to this repository. Existing checkouts are preserved.

```sh
node tools/bootstrap-ecosystem.mjs --root "$HOME/Documents/ShadowRoom"
```

Install dependencies described by each server's `pyproject.toml`. For a quick generic setup:

```sh
for repo in \
  rekordbox-serato-bridge audio-analysis-dedupe set-planner shadow-music-generator \
  stem-splitter soundfont-renderer steward library ShadowMusicGrabber
do
  python3 -m pip install -e "$HOME/Documents/ShadowRoom/$repo"
done
```

Generate a standard `mcpServers` JSON document using plugin virtualenvs when available:

```sh
node tools/print-mcp-config.mjs --root "$HOME/Documents/ShadowRoom" > shadowroom-mcp.json
```

The generated document uses this portable shape:

```json
{
  "mcpServers": {
    "shadowroom-library": {
      "command": "/absolute/path/to/python",
      "args": ["/absolute/path/to/library/mcp_server.py"],
      "cwd": "/absolute/path/to/library",
      "env": {
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8"
      }
    }
  }
}
```

Paste or import the generated `mcpServers` object into the target client. No ShadowRoom-specific
bridge is required for direct MCP use.

## Servers

| MCP id | Repository | Purpose | License |
| --- | --- | --- | --- |
| `converter` | [rekordbox-serato-bridge](https://github.com/shadowroommusic/rekordbox-serato-bridge) | Rekordbox ⇄ Serato playlists, cues, loops, and colors | AGPL-3.0 |
| `analysis` | [audio-analysis-dedupe](https://github.com/shadowroommusic/audio-analysis-dedupe) | Audio analysis, tempo/key detection, humming, duplicate detection | AGPL-3.0 |
| `planner` | [set-planner](https://github.com/shadowroommusic/set-planner) | DJ set timing and next-track recommendations | AGPL-3.0 |
| `generator` | [shadow-music-generator](https://github.com/shadowroommusic/shadow-music-generator) | Music generation, synthesis, arrangement, MIDI, and renders | AGPL-3.0 |
| `splitter` | [stem-splitter](https://github.com/shadowroommusic/stem-splitter) | Vocals, drums, bass, and other stem separation | AGPL-3.0 |
| `soundfont` | [soundfont-renderer](https://github.com/shadowroommusic/soundfont-renderer) | MIDI and notes rendered through SoundFont instruments | AGPL-3.0 |
| `steward` | [steward](https://github.com/shadowroommusic/steward) | Durable event ledger, summaries, and agent handoffs | AGPL-3.0 |
| `library` | [library](https://github.com/shadowroommusic/library) | Track indexing, BPM/key metadata, covers, crates, and cues | AGPL-3.0 |
| `grabber` | [ShadowMusicGrabber](https://github.com/shadowroommusic/ShadowMusicGrabber) | Probe, decrypt, transcode, and download audio | MIT |

## Notes

- `stem-splitter` may require a large Demucs environment. Its README documents remote-GPU mode.
- `soundfont-renderer` needs FluidSynth and a SoundFont on first use.
- `ShadowMusicGrabber` is MIT; all other ShadowRoom servers are AGPL-3.0-only.
- File-moving and deletion operations remain explicit confirmation flows in the desktop UI. A generic
  MCP client is responsible for applying its own approval policy.
