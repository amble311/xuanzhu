# L2：DOM 操作（改内容）+ L3：裸 XML

> `officecli` 技能的伴随文件。改文件基本都在这；**元素类型三张大表在 `element-types.md`**。

## set — modify properties

```bash
officecli set <file> <path> --prop key=value [--prop ...]
```

**Any XML attribute is settable** via element path (found via `get --depth N`) — even attributes not currently present. Without `find=`, `set` applies format to the entire element.

**Value formats:**

| Type | Format | Examples |
|------|--------|---------|
| Colors | Hex (with/without `#`), named, RGB, theme | `FF0000`, `#FF0000`, `red`, `rgb(255,0,0)`, `accent1`..`accent6` |
| Spacing | Unit-qualified | `12pt`, `0.5cm`, `1.5x`, `150%` |
| Dimensions | EMU or suffixed | `914400`, `2.54cm`, `1in`, `72pt`, `96px` |

**Dotted-attr aliases** — `font.<attr>` forms accepted on shape/run/paragraph/table/row/cell/section/styles, e.g. `--prop font.color=red --prop font.bold=true --prop font.size=14pt`. Run `officecli help <fmt> <element>` for the full list.

## find — format or replace matched text

Use top-level `--find` / `--replace` on `set` (and `--find` on `query`). Legacy `--prop find=X` still works but emits a hint.

```bash
# Format matched text (auto-splits runs)
officecli set doc.docx '/body/p[1]' --find weather --prop bold=true --prop color=red

# Regex matching (regex= still a prop flag)
officecli set doc.docx '/body/p[1]' --find '\d+%' --prop regex=true --prop color=red

# Replace text (use `/` for whole-document scope)
officecli set doc.docx / --find draft --replace final

# docx: tracked Find&Replace
officecli set doc.docx / --find draft --replace final --prop revision.author=Alice

# PPT — same syntax, different paths
officecli set slides.pptx / --find draft --replace final
```

**Path controls search scope:** `/` = whole document, `/body/p[1]` or `/slide[N]/shape[M]` = specific element, `/header[1]` / `/footer[1]` = headers/footers.

**Notes:**
- Case-sensitive by default. Case-insensitive: `--prop 'find=(?i)error' --prop regex=true`
- Matches work across run boundaries
- No match = silent success. `--json` includes `"matched": N`
- **Excel:** only `find` + `replace` supported (no find + format props)

## add — add elements or clone

```bash
officecli add <file> <parent> --type <type> [--prop ...]
officecli add <file> <parent> --type <type> --after <path> [--prop ...]   # insert after anchor
officecli add <file> <parent> --type <type> --before <path> [--prop ...]  # insert before anchor
officecli add <file> <parent> --type <type> --index N [--prop ...]        # 0-based position (legacy)
officecli add <file> <parent> --from <path>                               # clone existing element
```

`--after`, `--before`, `--index` are mutually exclusive. No position flag = append to end.

**Element types (with aliases):** 三张按格式分组的大表见 `element-types.md`（pptx / docx / xlsx）——
不确定属性名时优先 `officecli help <format> <element>`。

### Pivot tables (xlsx)

```bash
officecli add data.xlsx /Sheet1 --type pivottable \
  --prop source="Sheet1!A1:E100" --prop rows=Region,Category \
  --prop cols=Year --prop values="Sales:sum,Qty:count" \
  --prop grandTotals=rows --prop subtotals=off --prop sort=asc
```

Key props: `rows`, `cols`, `values` (Field:func[:showDataAs]), `filters`, `source`, `position`, `layout` (compact/outline/tabular), `repeatLabels`, `blankRows`, `aggregate`, `showDataAs` (percent_of_total/row/col, running_total), `grandTotals`, `subtotals`, `sort`. Aggregators: sum, count, average, max, min, product, stdDev, stdDevp, var, varp, countNums. Date columns auto-group. Run `officecli help xlsx pivottable` for full schema.

### Document-level properties (all formats)

```bash
officecli set doc.docx / --prop docDefaults.font=Arial --prop docDefaults.fontSize=11pt
officecli set doc.docx / --prop protection=forms --prop evenAndOddHeaders=true
officecli set data.xlsx / --prop calc.mode=manual --prop calc.refMode=r1c1
officecli set slides.pptx / --prop defaultFont=Arial --prop show.loop=true --prop print.what=handouts
```

Run `officecli help <format> /` for all document-level properties (docDefaults, docGrid, CJK spacing, calc, print, show, theme, extended).

### Sort (xlsx)

```bash
officecli set data.xlsx /Sheet1 --prop sort="C desc" --prop sortHeader=true
officecli set data.xlsx '/Sheet1/A1:D100' --prop sort="A asc" --prop sortHeader=true
```

Format: `COL DIR[, COL DIR ...]`. Rejects ranges with merged cells or formulas. Sidecar metadata (hyperlinks, comments, conditional formatting, drawings) follows rows automatically.

### Text-anchored insert (`--after find:X` / `--before find:X`)

Locate an insertion point by text match within a paragraph. Inline types (run, picture, hyperlink) insert within the paragraph; block types (table, paragraph) auto-split it. PPT only supports inline.

```bash
# Word: inline run after matched text
officecli add doc.docx '/body/p[1]' --type run --after find:weather --prop text=" (sunny)"

# Word: block table after matched text (auto-splits paragraph)
officecli add doc.docx '/body/p[1]' --type table --after "find:First sentence." --prop rows=2 --prop cols=2
```

### Clone

`officecli add <file> / --from '/slide[1]'` — copies with all cross-part relationships.

### move, swap, remove

```bash
officecli move <file> <path> [--to <parent>] [--index N] [--after <path>] [--before <path>]
officecli swap <file> <path1> <path2>
officecli remove <file> '/body/p[4]'
```

When using `--after` or `--before`, `--to` can be omitted — the target container is inferred from the anchor.

### batch — multiple operations in one save cycle

**Atomic by default (v1.0.137+):** every item still runs and is reported (so `N succeeded, M failed` stays meaningful and every failure surfaces), but if *any* item fails the whole batch rolls back — the file on disk is left byte-identical to before the batch ran (confirmed live in both standalone and resident mode). Use `--best-effort` to restore the old apply-what-succeeds behavior (useful for lossy `dump→batch` replays where losing the whole thing over one unsupported item is worse than a partial result). `--stop-on-error` only changes how early the run stops (remaining items are `skipped`), not whether what ran gets kept — combine it with `--best-effort` if you want "stop at first failure but keep what already succeeded." `--force` is unrelated — it's only the docx-protection bypass. Failed items carry a machine-readable `code` field (same list as `error.code`); a rolled-back batch's JSON summary carries `"atomicRolledBack": true`.

`officecli dump <file> [<path>]` emits a replayable batch JSON for round-trip — `.docx` (full coverage), `.pptx` (text/tables/pictures/charts/notes/theme + OLE/3D/video/audio/SmartArt/morph/p15 transitions via raw-set passthrough), and `.xlsx` (cells/formulas/styles + tables, conditional formatting, validations, comments, charts, sparklines, pictures, shapes, pivot tables; slicers/chartEx/OLE via verbatim carrier). Path defaults to `/` (whole document); pass a subtree path (docx: `/body`, `/body/p[N]`, `/body/tbl[N]`, `/theme`, `/settings`, `/numbering`, `/styles`; xlsx: `/SheetName`, `/sheet[N]`) to scope the dump. `officecli refresh <file.docx>` recalculates TOC page numbers / PAGE / cross-references after replay (Word backend on Windows; headless-HTML fallback elsewhere). `officecli plugins list` extends support to `.doc`, `.hwpx`, `.pdf` export.

```bash
echo '[
  {"command":"set","path":"/Sheet1/A1","props":{"value":"Name","bold":"true"}},
  {"command":"set","path":"/Sheet1/B1","props":{"value":"Score","bold":"true"}}
]' | officecli batch data.xlsx --json

officecli batch data.xlsx --commands '[{"op":"set","path":"/Sheet1/A1","props":{"value":"Done"}}]' --json
officecli batch data.xlsx --input updates.json --best-effort --json   # keep whatever succeeds even if some items fail
```

Supports: `add`, `set`, `get`, `query`, `remove`, `move`, `swap`, `view`, `raw`, `raw-set`, `validate`. Fields: `command` (or `op`), `path`, `parent`, `type`, `from`, `to`, `index`, `after`, `before`, `props`, `selector`, `mode`, `depth`, `part`, `xpath`, `action`, `xml`.

---

# L3: Raw XML

Use when L2 cannot express what you need. No xmlns declarations needed — prefixes auto-registered.

```bash
officecli raw <file> <part>                          # view raw XML
officecli raw-set <file> <part> --xpath "..." --action replace --xml '<w:p>...</w:p>'
officecli add-part <file> <parent>                   # create new document part (returns rId)
```

`raw-set` actions: `append`, `prepend`, `insertbefore`, `insertafter`, `replace`, `remove`, `setattr`. Run `officecli help <format> raw` for available parts.
