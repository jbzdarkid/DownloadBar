# Chromium 113 vector icons -- local cache

Verbatim copies of the `.icon` files (Chromium's bespoke C++-array vector format)
that the Chrome 113 download shelf reaches for. Cached here so we don't have to
round-trip to `chromium.googlesource.com` when re-checking geometry.

Source tag: `refs/tags/113.0.5672.63`.

## Files in this directory and their use in the shelf

| File                  | Chromium path                                  | Used by                                                            |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `close_rounded.icon`  | `components/vector_icons/close_rounded.icon`   | Shelf close button (`download_shelf_view.cc`)                      |
| `caret_up.icon`       | `components/vector_icons/caret_up.icon`        | Chip dropdown, idle state (`download_item_view.cc`)                |
| `caret_down.icon`     | `components/vector_icons/caret_down.icon`      | Chip dropdown, pressed/open state (`download_item_view.cc`)        |
| `menu_check.icon`     | `ui/views/vector_icons/menu_check.icon`        | Checkmark in chip context-menu (`menu_image_util.cc::GetMenuCheckImage` -> `kMenuCheckIcon`) |
| `warning.icon`        | `components/vector_icons/warning.icon`         | Mixed-content / insecure / scan-prompt warning chips (not mirrored)|
| `error.icon`          | `components/vector_icons/error.icon`           | Dangerous / malicious / blocked chips (not mirrored)               |
| `help.icon`           | `components/vector_icons/help.icon`            | Informational warning chips, non-CR2023 (not mirrored)             |
| `info.icon`           | `ui/views/vector_icons/info.icon`              | Informational warning chips, CR2023 (not mirrored)                 |

## What we currently mirror

The four graphics the extension actually paints today:

- `close_rounded.icon` -> inline SVG in `src/ui.js` (shelf close)
- `caret_up.icon`      -> inline SVG in `src/ui.js` (chip dropdown; CSS rotates 180deg for the open state, geometrically equivalent to `caret_down.icon`)
- `menu_check.icon`    -> inline SVG in `src/menu.js` (`menuCheckSvg()`; 16dp rep, fill=currentColor)
- `PaintDownloadProgress` (custom paint in `download_item_view.cc`, not a `.icon` file) -> `progressRingSvg` in `src/ui.js`

The warning / error / info / help icons are cached for completeness but the
extension never renders them: `chrome.downloads` doesn't surface the dangerous /
malicious / scanning states the native shelf draws.

## .icon format primer

A `.icon` file is a snippet of a `gfx::PathElement` array consumed by
`gfx::CreateVectorIcon()`. Each token (e.g. `MOVE_TO`, `R_LINE_TO`, `STROKE`,
`CANVAS_DIMENSIONS`, `CLIP`, `PATH_COLOR_ARGB`) is an enum + float operands.
Strokes use round caps and joins by default. An icon may contain multiple
`CANVAS_DIMENSIONS` blocks for different rasterization sizes; Skia picks the
closest match to the final device-pixel size.

Full command reference: `ui/gfx/vector_icon_types.h` in the Chromium tree.
