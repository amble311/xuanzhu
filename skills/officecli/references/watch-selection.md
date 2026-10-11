# Watch & Interactive Selection（浏览器里实时预览 + 点选）

> `officecli` 技能的伴随文件。仅当需要"用户在浏览器里点选、再由 CLI 动手"时才读。

Live HTML preview that auto-refreshes on every file change. Browsers can click / shift-click / box-drag to select shapes; the CLI can read the current browser selection and act on it.

```bash
officecli watch <file> [--port N]      # Start preview server (default port 26315)
officecli unwatch <file>               # Stop
officecli goto <file> <path>           # Scroll watching browser(s) to element (docx: p / table / tr / tc)
```

Open the printed `http://localhost:N` URL. Click to select; shift/cmd/ctrl+click to multi-select; drag from empty space to box-select. PPT/Word use blue outline; Excel uses native-style green selection (double-click cell to edit inline; drag a chart to reposition).

## `get <file> selected` — read what the user clicked

```bash
officecli get <file> selected [--json]
```

Returns DocumentNodes for whatever is currently selected. Empty result if nothing selected. Exit code != 0 if no watch is running.

```bash
# User clicks shapes in the browser, then asks "make these red"
PATHS=$(officecli get deck.pptx selected --json | jq -r '.data.Results[].path')
for p in $PATHS; do officecli set deck.pptx "$p" --prop fill=FF0000; done
```

## Key properties

- **Selection survives file edits.** Paths use stable `@id=` form.
- **All connected browsers share one selection.** Last-write-wins.
- **Same-file single-watch.** A given file can have only one watch process at a time.
- **Group shapes select as a whole.** Drilling into individual children of a group is not supported in v1.
- **Coverage:** `.pptx` shapes/pictures/tables/charts/connectors/groups; `.docx` top-level paragraphs and tables. Inherited layout/master decorations and Word nested elements (table cells, run-level) are not addressable. **`.xlsx` does not emit `data-path`** — `mark`/`selection` on xlsx always resolve `stale=true` (v2 candidate).

## Marks — edit proposals waiting for review

Use `mark` when changes need human review BEFORE they hit the file. Marks live in the watch process only; a separate `set` pipeline applies accepted ones. For one-shot changes use `set` directly; for permanent file annotations use `add --type comment` (Word native).

```bash
officecli mark <file> <path> [--prop find=... color=... note=... tofix=... regex=true] [--json]
officecli unmark <file> [--path <p> | --all] [--json]
officecli get-marks <file> [--json]
```

Props: `find` (literal or regex when `regex=true`; raw form `find='r"[abc]"'`), `color` (hex / `rgb(...)` / 22 named whitelist), `note`, `tofix` (drives apply pipeline). **Path** must be `data-path` format from watch HTML — see the subskills for the full pipeline.
