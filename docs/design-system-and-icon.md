# PageSift Design System, Surface Architecture & Icon Provenance

## 1. Architectural Visual Identity & Icon System

PageSift uses an original architectural vector icon (`assets/icons/pagesift-arch-master-1024.png`) designed to stay sharp from `16×16` browser toolbars up to `512×512` documentation assets:

- **Architectural Mark**: Crisp `#FFFFFF` squircle container (`#CBD5E1` stroke) enclosing a `#2563EB` electric-blue header strip and corner accent square over `#18181B` ink and `#CBD5E1` neutral UI bars.
- **Delivered Icon Assets**:
  - Architectural vector master: `assets/icons/pagesift-arch-master-1024.png` (prior masters `assets/icons/pagesift-master-1024.png` and `assets/icons/pagesift-blue-master-1024.png` remain archived in `assets/icons/`)
  - Store / documentation size: `assets/icons/icon-512.png`
  - Packaged MV3 extension icons: `assets/icons/icon-16.png`, `assets/icons/icon-32.png`, `assets/icons/icon-48.png`, `assets/icons/icon-128.png` (copied into `dist/extension/icons/` and verified by `scripts/validate-extension-package.ts`)
  - Side-by-side comparison sheet: `docs/assets/icon-palette-comparison.png`

![PageSift Icon Palette Comparison](assets/icon-palette-comparison.png)

---

## 2. Solid-Color Design System (`src/extension/ui/design-system.css`)

PageSift uses **solid flat colors exclusively** (zero gradients), **architectural rectangle radii (`4px` / `6px` / `8px` / `10px`, zero pill or circle badges)**, **soft layered drop shadows**, and **ASCII hyphens instead of em/en dashes**:

### Color Tokens

| Token | Light Theme (Default) | Dark Theme (Carbon) | Role |
| :--- | :--- | :--- | :--- |
| `--bg-canvas` | `#FAFAFA` | `#0D0E12` | Primary workbench canvas |
| `--bg-surface` | `#FFFFFF` | `#15171D` | Sidebar, header, panels, cards |
| `--bg-elevated` | `#F5F6F8` | `#1C1F27` | Group headers, notices, subtle elevated regions |
| `--bg-subtle` | `#EFF1F5` | `#232732` | Hover fills and secondary surfaces |
| `--border-subtle` | `#E5E7EB` | `#262A35` | Crisp 1px structural borders |
| `--border-strong` | `#D1D5DB` | `#363C4C` | Interactive input & button borders |
| `--text-primary` | `#111827` | `#F4F4F5` | Primary headings & body copy |
| `--text-secondary` | `#374151` | `#D4D4D8` | Secondary labels & navigation |
| `--text-muted` | `#6B7280` | `#9CA3AF` | Metadata & helper text |
| `--ink-btn` / `--ink-btn-fg` | `#18181B` / `#FFFFFF` | `#F4F4F5` / `#111827` | High-contrast ink controls |
| `--accent` / `--accent-fg` | `#2563EB` / `#FFFFFF` | `#2563EB` / `#FFFFFF` | Primary actions & active indicators |
| `--accent-surface` / `--accent-text` | `#EFF6FF` / `#1D4ED8` | `#172554` / `#60A5FA` | Active navigation & tag highlight |
| `--positive` | `#0F766E` | `#14B8A6` | Positive status dots & completion indicators only |
| `--danger` | `#DC2626` | `#EF4444` | Errors & destructive actions only |
| `--shadow-sm` / `--shadow-lg` | Multi-stop soft slate drop shadows | Multi-stop deep charcoal shadows | Elevation separation across bars, drawers, and dialogs |

### Local Typography, Tactile Motion & Dock Centering

- **Bundled Local Fonts (`dist/extension/fonts/`)**:
  - **Instrument Sans** (`400`, `500`, `600`, `700`, SIL OFL-1.1) for UI controls, navigation, and headings.
  - **IBM Plex Mono** (`400`, `500`, `600`, SIL OFL-1.1) for selectors, dimensions, hex/RGB tokens, URLs, timestamps, and code blocks.
  - Zero external font requests (`fonts.googleapis.com` / third-party CDNs are never called).
- **Transform-Safe Horizontal Overlay Centering**:
  - `.ps-anchor` uses `left: 0; right: 0; margin: 0 auto; width: fit-content;` so horizontal bottom-center positioning never relies on `translateX(-50%)` and never collides with `.ps-enter` / `ps-rise` (`translateY(6px) scale(0.985)`) keyframe animations.
- **Tactile Micro-Interactions**:
  - Buttons across the Dashboard and Shadow DOM overlay apply `120ms-180ms` hover lift (`translateY(-1px)`), active detent, and `tap-confirm` confirmation feedback (`pagesift-tap-flash` / `ps-tap`), completely disabled under `@media (prefers-reduced-motion: reduce)`.
- **Verified Accessibility & Responsiveness**:
  - Zero horizontal overflow across `360px`, `390px`, `768px`, `1280px`, `1440px`, AND genuine Chromium **200% browser zoom** (`chrome.tabs.setZoom(tabId, 2.0)`).
  - Keyboard-accessible modals (`Escape` + focus restoration), visible `2px` focus rings, skip links, `role="status"` announcements, and collapsible navigation sidebar (`sidebarCollapsed` persisted in `chrome.storage.local`).

---

## 3. Three-Surface Research Workflow

1. **Toolbar Click -> Bottom-Center Horizontal Overlay Dock (`src/extension/content/overlay-dashboard.ts`)**:
   - `manifest.json` omits `action.default_popup` so `chrome.action.onClicked` toggles the Shadow DOM overlay (`#pagesift-root-host[data-pagesift-root="true"]`) horizontally centered in the mid-under area of supported `http(s)://` pages. On restricted browser pages (`chrome://`, `file://`, Web Store), clicking the toolbar icon opens the persistent dashboard with a clear notice (`?unsupportedUrl=...`).
   - Supports customizable pinned quick tools (`3` to `6`), upward/downward unfolding `All 15` drawer with live filter and site-scoped recent activity, `Customize` drawer (`bottom-center` / `bottom-right` / `top-center`, `follow` / `light` / `dark`, pinned tool checkboxes), minimize to compact bottom bar, close (`x` or `Escape`), automatic minimize during element picking with automatic restore upon selection, categorized **Tech Stack** result cards, inline `edit_text` / `swap_font` / `arrange` preview editor, and one-click handoff to the full dashboard.
   - Scoped customization updates use `UPDATE_OVERLAY_CUSTOMIZATION` (restricting content scripts to presentation fields only).
   - Completely excluded from extraction, measurement, cloning, and screenshot captures.
2. **Persistent Research Dashboard (`workspace.html` / `workspace.ts` / `tool-renderers.ts`)**:
   - Collapsible sidebar with three top-level sections: **Tools** (all 15 grouped & searchable tools with structured views including categorized **Tech Stack** cards and optional Raw Output disclosure), **Activity History** (local timeline of explicit PageSift tool runs with day/session grouping, 6 filters, search, pagination, Open Result / Reopen Site / Rerun / Delete / Clear History modal, and recording pause toggle), and **Saved Work** (local projects, artifacts, captures, and persisted background jobs).
3. **Settings Page (`options.html` / `options.ts`)**:
   - Theme, overlay dock defaults, and export defaults; Activity History recording toggle & retention cleanup; optional session-only AI provider configuration (NVIDIA NIM, OpenAI, OpenRouter, Groq, or custom SSRF-validated HTTPS / localhost endpoints) with user-supplied API keys; live IndexedDB usage strip; JSON backup export/download/file-import (`schemaVersion: 2`); and confirmation-gated local reset.

---

## 4. Visual Verification Snapshots

Real Chromium screenshots from the look-and-fix audit are stored in `docs/assets/screenshots/`:
- `revamp_01_overlay_dark.png`, `revamp_01b_overlay_all15_light.png`, `revamp_01c_overlay_customize_light.png`, `revamp_02_overlay_minimized.png`, `revamp_03_overlay_light.png`
- `revamp_04_dashboard_inspect_dark.png`, `revamp_05_dashboard_colors_light.png`, `revamp_13_dashboard_tech_stack_light.png`
- `revamp_06_dashboard_history_dark.png`, `revamp_07_dashboard_history_light.png`, `revamp_08_dashboard_saved_dark.png`
- `revamp_09_dashboard_narrow_390.png`, `revamp_10_dashboard_zoom_200.png`
- `revamp_11_options_dark.png`, `revamp_12_options_light.png`
