# GeoMirage Design System

## 1. Visual Theme & Atmosphere

GeoMirage is a dark-mode-native desktop tool UI built for an Electron + React + Leaflet map application. The canvas is a near-black surface (`#0a0a0c`) designed to let the map take visual priority while floating control panels, toolbars, and status indicators sit on top as translucent overlays. The overall feel is a compact, tool-dense cockpit — closer to a desktop IDE sidebar than a marketing page.

The design language draws from iOS-style segmented controls (`.seg-*` system) layered on dark surfaces, with solid high-alpha dark panels floating over the map. Information density is high: body text defaults to 13px, and most UI operates in the 11–13px range with weight shifts (500 → 600) providing hierarchy rather than size contrast.

> **Note on glass surfaces.** The primary floating chrome (`.glass-pill`, `.glass-panel`, variants) is rendered as solid `rgba(19, 20, 22, 0.92–0.94)` dark fills rather than `backdrop-filter: blur()`. Chromium has a fundamental tile-boundary artifact when sampling a tiled backdrop (the Leaflet map) through a blur kernel on elements wider than ~256px: adjacent GPU compositor tiles resolve the filter with slightly different precision, producing a visible vertical color seam across every wide surface (SearchBar, BottomDock, BottomModeBar). None of the standard workarounds (`saturate()` removal, `clip-path`, layer promotion via `translateZ` / `will-change`, pseudo-element architecture) moves the seam because it originates in the backdrop sampling path, not the element. Safari is unaffected. Solid 0.92+ alpha keeps the floating-chrome reading without exposing the sampling path. `backdrop-filter` is still used on small, short-lived elements (`.modal-overlay`, `.toast-pill`, `.map-pin-dest .label`) where the seam is either invisible or not perceptible.

The color system is almost entirely achromatic — dark backgrounds with white/gray text — punctuated by a single accent: a violet (`#a78bfa`, Tailwind violet-400) used for active states, focus rings, and CTAs. Semantic colors (success teal, danger red, warning yellow) appear only in status contexts. A subtle noise texture overlay (`opacity: 0.035`) adds film-grain atmosphere to the dark canvas.

**Key Characteristics:**
- Dark-mode-native: `#0a0a0c` canvas, `#131416` panels, `#1a1b20` elevated surfaces
- Geist as primary font, Geist Mono for coordinates/code
- Compact 13px base font size — this is a tool UI, not a reading experience
- Weight-driven hierarchy: 400 (reading), 500 (labels), 600 (emphasis/CTA)
- Single accent violet `#a78bfa` — the only chromatic color in the UI chrome
- Semi-transparent white borders (`rgba(255,255,255,0.05)` to `rgba(255,255,255,0.12)`)
- Solid high-alpha dark panels floating over a full-screen map (see note on glass surfaces above)
- iOS-style segmented control system (`.seg-*`) as the primary component pattern
- 4px base spacing grid

## 2. Color Palette & Roles

### Background Surfaces
| Token | Value | Role |
|-------|-------|------|
| `--color-surface-0` | `#0a0a0c` | App canvas — the deepest background |
| `--color-surface-1` | `#131416` | Panel backgrounds, status bar, popups |
| `--color-surface-2` | `#1a1b20` | Elevated elements: buttons, inputs, cards |
| `--color-surface-3` | `#222328` | Highest floating layer: segment groups, dropdowns |
| `--color-surface-hover` | `#282a31` | Hover state for interactive surfaces |

### Text
| Token | Value | Role | Min contrast on `surface-0` |
|-------|-------|------|-----------------------------|
| `--color-text-1` | `#e8eaf0` | Primary text — headings, labels, button text. Not pure white. | 14.8:1 (AAA) |
| `--color-text-2` | `#8b8fa3` | Secondary text — descriptions, section titles, muted labels | 4.7:1 (AA) |
| `--color-text-3` | `#7a7e94` | Tertiary text — placeholders, timestamps, disabled content | 5.1:1 (AA) |

> Raised `--color-text-3` from `#555869` → `#7a7e94` to clear WCAG AA (4.5:1) on `surface-0`/`surface-1`. The previous value (2.56:1) failed for any visible text.

### Accent
| Token | Value | Role |
|-------|-------|------|
| `--color-accent` | `#a78bfa` | Primary violet — CTAs, focus rings, active states, toggle on |
| `--color-accent-hover` | `#b9a3fc` | Hover variant for accent elements |
| `--color-accent-strong` | `#c4b5fd` | High-contrast accent text for use on `accent-dim` backgrounds (chip-on / pill-on labels) |
| `--color-accent-dim` | `rgba(167,139,250,0.12)` | Tinted background for active chips, selected items |
| `--color-accent-glow` | `rgba(167,139,250,0.25)` | Box-shadow glow on primary buttons |

> `--color-accent` (`#a78bfa`) measures 7.27:1 on `surface-0`, 6.77:1 on `surface-1`, 6.32:1 on `surface-2` and 5.76:1 on `surface-3`. On `accent-dim` it drops to 5.26:1 over `surface-2` and 4.77:1 over `surface-3`, close to the AA line; `--color-accent-strong` (`#c4b5fd`) stays at 7.0:1 or higher on every `accent-dim` combination. Use `--color-accent-strong` for any accent-colored text rendered over an accent-tinted background.

### Semantic / Status
| Token | Value | Role |
|-------|-------|------|
| `--color-success` | `#4ecdc4` | Active/connected states, speed mode active (icons / borders) |
| `--color-success-dim` | `rgba(78,205,196,0.15)` | Tinted background for success states |
| `--color-success-text` | `#34d399` | High-contrast success text for inline copy (replaces `text-green-400`) |
| `--color-danger` | `#ff4757` | Error, disconnect, delete actions (icons / borders) |
| `--color-danger-dim` | `rgba(255,71,87,0.15)` | Tinted background for danger states |
| `--color-danger-text` | `#ff8585` | Lighter danger for inline text. Raised from `#ff6b6b` to clear AA on `surface-0` |
| `--color-error-text` | `#f87171` | Inline error text alias (replaces `text-red-400`) |
| `--color-warning` | `#ffd93d` | Warning states, caution indicators |
| `--color-warning-dim` | `rgba(255,217,61,0.15)` | Tinted background for warning states |
| `--color-warning-text` | `#ffc107` | Lighter warning for inline text/icons |
| `--color-amber-text` | `#fbbf24` | Inline amber/orange text (replaces `text-amber-300/400`) |
| `--color-amber-dim` | `rgba(251,191,36,0.15)` | Tinted background (replaces `bg-amber-400/15`) |

### Device
| Token | Value | Role |
|-------|-------|------|
| `--color-device-a` | `#4285f4` | Device A identification (Google Blue) |
| `--color-device-b` | `#ff9800` | Device B identification (Amber) |
| `--color-device-c` | `#4ecdc4` | Device C identification (Teal) |
| `--color-device-d` | `#e040fb` | Device D identification (Purple) |
| `--color-device-idle` | `#4ecdc4` | Device status: idle |
| `--color-device-paused` | `#ffb627` | Device status: paused |
| `--color-device-error` | `#ff6b6b` | Device status: error/disconnected |

### Category (Bookmarks)
| Token | Value | Role |
|-------|-------|------|
| `--color-cat-default` | `#4285f4` | Default bookmark category |
| `--color-cat-home` | `#4caf50` | Home bookmark category |
| `--color-cat-work` | `#ff9800` | Work bookmark category |

### Waypoint markers
Used by MapView's waypoint SVG icons. Hex is mirrored in `lib/constants.ts`
(`MARKER_HEX`) because Leaflet writes these into SVG attributes which
cannot resolve `var()`.

| Token | Value | Role |
|-------|-------|------|
| `--color-marker-start` | `#43a047` | Start marker ring |
| `--color-marker-start-inner` | `#2e7d32` | Start marker inner fill |
| `--color-marker-end` | `#fb8c00` | End marker ring |
| `--color-marker-end-inner` | `#ef6c00` | End marker inner fill |

### Extra surfaces
| Token | Value | Role |
|-------|-------|------|
| `--color-surface-ghost` | `rgba(255,255,255,0.04)` | Lightly-recessed tint over `surface-1` (BottomDock rows, inline hint strips) |

### Decorative gradients
Reserved for specific chrome elements; do not use for generic panels.

| Token | Value | Role |
|-------|-------|------|
| `--gradient-joystick-base` | `radial-gradient(circle at 30% 30%, #2a2e38, #14161c)` | Joystick decorative base (BottomDock) |
| `--gradient-joystick-knob` | `linear-gradient(145deg, #3a3f4a, #1e2128)` | Joystick decorative knob (BottomDock) |

### Border
| Token | Value | Role |
|-------|-------|------|
| `--color-border` | `rgba(255,255,255,0.08)` | Standard border — cards, inputs, panels |
| `--color-border-subtle` | `rgba(255,255,255,0.05)` | Ultra-subtle dividers, section separators |
| `--color-border-strong` | `rgba(255,255,255,0.12)` | Emphasis border — hover states, active elements |
| `--color-border-focus` | `rgba(167,139,250,0.4)` | Focus ring for inputs |

### Overlay
| Token | Value | Role |
|-------|-------|------|
| `--color-overlay` | `rgba(8,10,20,0.55)` | Standard modal backdrop |
| `--color-overlay-heavy` | `rgba(20,22,32,0.85)` | Heavy overlay (DDI mount, blocking states) |

### Shadows
| Token | Value | Role |
|-------|-------|------|
| `--shadow-sm` | `0 2px 8px rgba(0,0,0,0.25)` | Subtle lift — toolbar buttons, controls |
| `--shadow-md` | `0 4px 16px rgba(0,0,0,0.35)` | Standard elevation — panels, cards |
| `--shadow-lg` | `0 8px 32px rgba(0,0,0,0.45)` | High elevation — popups, context menus, toasts |
| `--shadow-xl` | `0 20px 60px rgba(12,18,40,0.65)` | Maximum elevation — modals |
| `--shadow-glow` | `0 0 24px rgba(167,139,250,0.28)` | Accent glow — primary CTA buttons |
| `--shadow-inset` | `inset 0 1px 0 rgba(255,255,255,0.06)` | Top-edge highlight for glass-like surfaces |

## 3. Typography

### Font Families
- **Primary** (`body` in `styles/base.css`): `'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif`
- **Monospace** (`--font-mono`): `'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace`
- Both families load from Google Fonts in `index.html`.

### Font Features
- Body: `-webkit-font-smoothing: antialiased`, `letter-spacing: -0.005em`
- Numbers/Code: `font-variant-numeric: tabular-nums`, `font-feature-settings: 'tnum' 1, 'cv11' 1`

### Size Scale
| Token | Value | Usage |
|-------|-------|-------|
| `--text-2xs` | 10px | Keyboard hints, overline labels, monospace coords |
| `--text-xs` | 11px | Section titles (uppercase), control labels, segment labels |
| `--text-sm` | 12px | Buttons, secondary body, search input, speed labels |
| `--text-base` | 13px | Default body text, context menu items, CTA text |
| `--text-md` | 14px | Modal titles, caption labels |
| `--text-lg` | 16px | Panel headings, dialog titles |
| `--text-xl` | 20px | Large headings |
| `--text-2xl` | 24px | Display text (reserved) |
| `--text-3xl` | 32px | Hero/display text (reserved) |

### Line Heights
| Token | Value | Usage |
|-------|-------|-------|
| `--leading-tight` | 1.15 | Display/hero text, compressed headlines |
| `--leading-snug` | 1.3 | Headings, compact lists |
| `--leading-normal` | 1.5 | Default body text (inherited from body) |
| `--leading-relaxed` | 1.6 | Long-form reading, descriptions |

### Letter Spacing
| Token | Value | Usage |
|-------|-------|-------|
| `--tracking-tight` | -0.02em | Display sizes, compressed headlines |
| `--tracking-normal` | -0.005em | Default body (set globally) |
| `--tracking-wide` | 0.08em | Uppercase section titles, overline labels |

### Weight System
| Weight | Role | Usage |
|--------|------|-------|
| 400 | Reading | Body text, descriptions, placeholders |
| 500 | Labels | Segment labels, chips, navigation, medium emphasis |
| 600 | Emphasis | Section titles, CTA buttons, active states, headings |

### Hierarchy in Practice
| Role | Size | Weight | Color | Extras |
|------|------|--------|-------|--------|
| Panel heading | 15–16px | 600 | text-1 | — |
| Section title | 11px | 600 | text-2 | `uppercase`, `letter-spacing: var(--tracking-wide)` |
| Control label | 11px | 500 | text-2 | — |
| Body / button | 12–13px | 500–600 | text-1 | — |
| Secondary text | 12px | 400 | text-2 | — |
| Muted / tertiary | 11px | 400 | text-3 | — |
| Monospace data | 10px | 400 | text-2/3 | `font-mono`, `tabular-nums` |

## 4. Component Styling

### Surface Utilities (pre-composed)
```css
.surface-panel   → surface-1 bg + standard border + shadow-md
.surface-control → surface-1 bg + standard border + shadow-sm
.surface-popup   → surface-1 bg + standard border + shadow-lg
```

### Segment System (`.seg-*`)
The primary component system — iOS-style stacked groups:
- `.seg-stack` — vertical flex container, 10px gap
- `.seg` — segment group: surface-3 bg, standard border, 14px radius
- `.seg-row` — row within segment: 10px 14px padding, 40px min-height
- `.seg-chip` — selectable chip: off (surface-1) / on (accent-dim + accent text)
- `.seg-pill` — compact pill variant of chip
- `.seg-input` — input within segment: surface-1 bg, 6px radius
- `.seg-cta` — full-width call-to-action button: 10px radius, 600 weight
  - Variants: `-accent`, `-danger`, `-ghost`
- `.seg-hint` — info row: `rgba(255,255,255,0.02)` bg, 10px radius
- `.toggle-switch` — 36x20px toggle: accent bg when checked

### Buttons
| Class | Background | Border | Radius | Usage |
|-------|-----------|--------|--------|-------|
| `.action-btn` | surface-2 | standard | 12px | Standard interactive buttons |
| `.action-btn.primary` | accent | accent | 12px | Primary CTA with glow shadow |
| `.action-btn.danger` | danger-dim | danger 0.3 | 12px | Destructive actions |
| `.action-btn.success` | success-dim | success 0.3 | 12px | Positive confirmations |
| `.mode-btn` | surface-2 | transparent | 12px | Mode selection |
| `.mode-btn.active` | accent-dim | accent | 12px | Active mode with inset ring |
| `.speed-btn` | surface-2 | standard | 12px | Speed selection cards |
| `.seg-cta-accent` | accent | none | 10px | Segment CTA (full-width) |

### Status Badge
Compact inline badges for status indicators and action buttons:
```css
.status-badge          → base: inline-flex, gap-4, padding 2px 8px, radius-xs
.status-badge-accent   → accent-dim bg, accent border, accent text
.status-badge-warning  → warning-dim bg, warning border, warning-text
.status-badge-success  → success-dim bg, success border, success text
.status-badge-danger   → danger-dim bg, danger border, danger text
.status-badge-ghost    → rgba(255,255,255,0.04) bg, text-2
```

### Modal / Dialog
Reusable overlay + dialog surface:
```css
.modal-overlay → fixed inset, z-modal, overlay bg, backdrop-blur(4px), centered flex
.modal-dialog  → 360px, surface bg, accent-tinted border, radius-md, shadow-xl, scale-in animation
.modal-title   → 15px, weight 600
.modal-body    → text-sm, 0.75 opacity, leading-normal
.modal-actions → flex end, gap-8, margin-top 16px
```

### Toast / Notification
```css
.toast-pill         → fixed center, backdrop-blur(16px), shadow-lg, radius-lg, z-toast
.toast-pill-dark    → rgba(24,26,32,0.88) bg, text-1
.toast-pill-warning → rgba(255,152,0,0.92) bg, dark text
.toast-pill-danger  → rgba(255,71,87,0.92) bg, white text
```

### Separator
```css
.separator-v → 1px wide, 14px tall, border-strong bg
.separator-h → 1px tall, border-subtle bg
```

### Skeleton / Loading
```css
.skeleton → gradient shimmer animation, surface-2 → surface-3 → surface-2, 1.5s loop
```

### Context Menu
```css
.context-menu      → surface-2 bg, standard border, 12px radius, shadow-lg, z-dropdown
.context-menu-item → 8px 14px padding, 13px text, hover: accent-dim bg
```

## 5. Layout

### Spacing Scale (4px base grid)
| Token | Value |
|-------|-------|
| `--spacing-0_5` | 2px |
| `--spacing-1` | 4px |
| `--spacing-1_5` | 6px |
| `--spacing-2` | 8px |
| `--spacing-2_5` | 10px |
| `--spacing-3` | 12px |
| `--spacing-3_5` | 14px |
| `--spacing-4` | 16px |
| `--spacing-5` | 20px |
| `--spacing-6` | 24px |
| `--spacing-7` | 28px |
| `--spacing-8` | 32px |
| `--spacing-9` | 36px |
| `--spacing-10` | 40px |
| `--spacing-12` | 48px |
| `--spacing-14` | 56px |
| `--spacing-16` | 64px |

### Border Radius Scale
| Token | Value | Usage |
|-------|-------|-------|
| `--radius-xs` | 4px | Status badges, inline tags, tiny containers |
| `--radius-sm` | 8px | Bookmark items, search results, small containers |
| `--radius-md` | 12px | Buttons, inputs, mode buttons, cards, popups |
| `--radius-lg` | 16px | Sections, toast pills |
| `--radius-xl` | 20px | Large panels |
| `--radius-full` | 9999px | Scrollbar thumbs, toggle switches, pill shapes |

### Control Heights
| Token | Value | Usage |
|-------|-------|-------|
| `--control-sm` | 32px | Compact, non-primary controls — pair with a 36–44px hit area when interactive |
| `--control-md` | 38px | Default control height |
| `--control-lg` | 44px | Primary CTA buttons (matches WCAG 2.5.5 / iOS HIG minimum) |

### Target Size Tiers (WCAG 2.5.5 / iOS HIG)
| Tier | Min size | Usage |
|------|----------|-------|
| Recommended | 44×44px | Primary actions, mode toggles, top-bar icons, drawer close, joystick — first choice for any standalone tap target. |
| Acceptable | 36×36px | Inline list actions, segmented chips/pills, secondary buttons inside dense panels. Backed by `min-height: 36px` on `.action-btn`, `.context-menu-item`, `.seg-cta-sm`, `.seg-chip`, `.seg-pill`, `.bookmark-item`. |
| Minimum | 24×24px | Inline icons inside text rows where the surrounding row provides ≥36px hit area. Avoid for standalone controls. |

### App Layout Structure
```
┌──────────────────────────────────────────┐
│ Map (full screen, z-base)                │
│                                          │
│  ┌─────────┐            ┌──────────────┐ │
│  │ Mode    │            │ Floating     │ │
│  │ Toolbar │            │ Panel        │ │
│  │ (left)  │            │ (right)      │ │
│  │ z-ui    │            │ z-ui         │ │
│  └─────────┘            └──────────────┘ │
│                                          │
│        ┌──────────────────┐              │
│        │ ETA Bar (top)    │  z-eta       │
│        └──────────────────┘              │
│                         ┌──────────┐     │
│                         │ Joystick │     │
│                         │ z-float  │     │
│                         └──────────┘     │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │ Status Bar (bottom)    z-bar     │    │
│  └──────────────────────────────────┘    │
└──────────────────────────────────────────┘
```

### Responsive Breakpoints
| Breakpoint | Width | Behavior |
|------------|-------|----------|
| Extra small | ≤480px | Status bar: 10px font, tighter padding |
| Small mobile | ≤640px | Floating panel → bottom sheet, mode toolbar → horizontal bottom bar |
| Tablet | ≤768px | Joystick shrinks (140px → 120px), repositioned |

## 6. Z-Index Scale

All z-index values are defined as CSS custom properties in `src/styles/tokens.css`:

| Token | Value | Usage |
|-------|-------|-------|
| `--z-base` | 0 | Map canvas, noise overlay, base elements |
| `--z-bar` | 200 | Status bar |
| `--z-eta` | 390 | ETA pill — above the map, below the top bar so the search dropdown wins |
| `--z-ui` | 400 | TopBar, ModeToolbar, FloatingPanel, SettingsMenu |
| `--z-float` | 500 | Toasts, joystick, bookmark popups, bookmark add dialog |
| `--z-dropdown` | 600 | Context menus, dropdowns, search results |
| `--z-map-ui` | 650 | Map controls (zoom, layer picker) — above the bottom dock / mode bar, below drawer / overlay / modal |
| `--z-drawer` | 700 | Drawer backdrop + panel (DeviceDrawer, LibraryDrawer) |
| `--z-overlay` | 800 | Heavy overlays (DDI mount) |
| `--z-popover` | 850 | Body-portaled popup menus (KebabMenu) — above the drawer that hosts the trigger, below modals |
| `--z-modal` | 900 | Modals (initial position, repair confirm, update checker) |
| `--z-toast` | 950 | Toast notifications (above everything) |

Map chrome only has to beat the Leaflet map subtree, which forms its own stacking context, so `--z-eta` and `--z-map-ui` sit below drawers and modals on purpose.

**Note:** Leaflet's internal `zIndexOffset` for markers (1000+) operates within the map's own stacking context and is unrelated to the application z-index scale.

## 7. Depth & Elevation

| Level | Treatment | Usage |
|-------|-----------|-------|
| Canvas (0) | No shadow, `#0a0a0c` bg | Map background, app canvas |
| Recessed (1) | `surface-1` bg + subtle border | Status bar, panel chrome |
| Default (2) | `surface-2` bg + standard border + `shadow-sm` | Buttons, inputs, cards |
| Elevated (3) | `surface-3` bg + standard border + `shadow-md` | Segment groups, floating panels |
| Floating (4) | High-alpha dark fill (0.92–0.94) + `shadow-lg` | Floating glass chrome, context menus, joystick (`.toast-pill` and `.modal-overlay` retain backdrop-blur — see §1 note) |
| Modal (5) | `shadow-xl` + `shadow-inset` | Modal dialogs |
| Overlay | `--color-overlay` backdrop | Modal backgrounds |

**Elevation philosophy**: On dark surfaces, depth is communicated through background luminance stepping (`0a → 13 → 1a → 22 → 28`) combined with border opacity (`0.05 → 0.08 → 0.12`). Shadows serve as secondary depth cues. High-alpha dark fills (0.92+) give floating glass chrome its weight without exposing the Chrome backdrop-filter seam (see §1). The `--shadow-inset` token provides a top-edge highlight for glass-like panels.

## 8. Motion & Animation

### Easing Functions
| Token | Value | Character |
|-------|-------|-----------|
| `--ease-out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | Snappy deceleration — primary UI easing |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Bouncy overshoot — markers, playful elements |

### Duration Tokens
| Token | Value | Usage |
|-------|-------|-------|
| `--duration-fast` | 80ms | Button `:active` scale feedback |
| `--duration-normal` | 140ms | Buttons, search, mode selection (the "default") |
| `--duration-slow` | 200ms | Panel collapse/expand |
| `--duration-enter` | 200ms | Enter animations |
| `--duration-exit` | 150ms | Exit animations (faster than enter) |

### Enter Animations
| Class | Animation | Duration |
|-------|-----------|----------|
| `.anim-fade-in` | Opacity 0→1 | `--duration-enter` |
| `.anim-fade-slide-up` | Opacity + translateY(6px→0) | `--duration-enter` |
| `.anim-fade-slide-down` | Opacity + translateY(-8px→0) | `--duration-enter` |
| `.anim-scale-in` | Opacity + scale(0.96→1) | `--duration-enter` |
| `.anim-scale-in-tl` | Opacity + scale(0.94→1) from top-left | 160ms |

### Exit Animations
| Class | Animation | Duration |
|-------|-----------|----------|
| `.anim-fade-out` | Opacity 1→0 | `--duration-exit` |
| `.anim-fade-slide-up-out` | Opacity + translateY(0→-6px) | `--duration-exit` |
| `.anim-scale-out` | Opacity + scale(1→0.96) | `--duration-exit` |

### Stagger Delays
| Class | Delay |
|-------|-------|
| `.stagger-1` | 30ms |
| `.stagger-2` | 60ms |
| `.stagger-3` | 90ms |
| `.stagger-4` | 120ms |
| `.stagger-5` | 150ms |

### Map Animations
| Name | Duration | Usage |
|------|----------|-------|
| `pulse-expand` | 2.5s infinite | Position marker ripple |
| `marker-drop` | 420ms spring | Destination marker drop-in |
| `marker-pop` | 280ms spring | Waypoint marker pop |
| `chip-pulse` | infinite | Active device chip breathing |
| `pulse-glow` | infinite | Accent box-shadow breathing |

### Accessibility
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 8a. Accessibility Standards (WCAG AA + iOS HIG)

This section captures how the design system maps to **WCAG 2.2 AA** and the **iOS Human Interface Guidelines**, and the deliberate desktop deviations.

### Color Contrast (WCAG 1.4.3 / 1.4.11)
- All body text on `surface-0`/`surface-1` clears 4.5:1.
- Use `*-text` semantic tokens (`--color-success-text`, `--color-danger-text`, `--color-error-text`, `--color-amber-text`) for inline status copy. Reserve the base color (`--color-success`, `--color-danger`, `--color-warning`) for icons, borders, and large display chrome where the 3:1 non-text rule applies.
- Never render `--color-accent` text on an `accent-dim` background — use `--color-accent-strong` instead.

### Touch Target Sizing (WCAG 2.5.5 / 2.5.8)
- Standalone interactive controls target **44×44px** (recommended) or **36×36px** (acceptable for dense in-panel buttons).
- The CSS classes `.action-btn`, `.context-menu-item`, `.seg-cta-sm`, `.seg-chip`, `.seg-pill`, `.bookmark-item` enforce `min-height: 36px`.
- `.seg-cta` enforces `min-height: 44px` because it is always a primary action.

### Focus Management (WCAG 2.4.7)
- Every interactive class has a `:focus-visible` outline (`2px solid var(--color-accent)`, 2px offset).
- The base `:focus-visible` rule in `@layer base` is the fallback; semantic classes (chips, pills, CTAs, action-btn, bookmark-item, context-menu-item, toggle-switch) override with surface-aware styling.

### Motion (WCAG 2.3.3)
- `prefers-reduced-motion` collapses all animation/transition durations to 0.01ms.
- Default durations (80–200ms) align with iOS HIG — fast, purposeful, never decorative.

### Semantic HTML & ARIA
- Interactive elements MUST be real `<button>` or `<a>` elements — never `<div onClick>`.
- Modals/drawers use `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and trap focus while open.
- Toggles use `role="switch"` + `aria-checked`; multi-select chips use `aria-pressed`.
- The skip-link in `App.tsx` jumps focus to the map container — exposed only on `:focus-visible`.

### iOS HIG Desktop Adaptations (deliberate deviations)
| HIG Default | Our value | Why |
|-------------|-----------|-----|
| Body 17pt | 13px base | Information-dense desktop tool UI; rendered for mouse/keyboard, not touch. |
| 44pt single tap target | 36px acceptable tier | Mouse-first input reduces minimum need; primary actions still 44px. |
| SF Pro family | Geist | Cross-platform consistency in an Electron app. |
| System dark/light | Dark only | Mapping/satellite tool — light mode would compete with map tile contrast. |

## 9. Tailwind CSS Integration

GeoMirage uses **Tailwind CSS v4** via the Vite plugin (`@tailwindcss/vite`). There is no `tailwind.config.js` — Tailwind v4 reads tokens directly from the `@theme` block in `src/styles/tokens.css`. `src/index.css` only `@import`s Tailwind, `tokens.css` (first) and the files under `src/styles/`.

### How It Works
1. Design tokens are defined in `@theme { }` in `src/styles/tokens.css`
2. Tailwind v4 automatically generates utility classes from these tokens
3. Components use a mix of:
   - **Tailwind utilities**: `flex`, `gap-2`, `p-3`, `rounded-lg`, `items-center`
   - **Tailwind with CSS vars**: `text-[var(--color-text-1)]`, `bg-[var(--color-surface-2)]`, `z-[var(--z-ui)]`
   - **Pre-composed CSS classes**: `.seg-row`, `.action-btn`, `.mode-btn`, `.modal-overlay`

### Conventions
- Use token references in Tailwind arbitrary values: `z-[var(--z-ui)]` not `z-[400]`
- Use CSS variable classes for colors: `text-[var(--color-text-2)]`
- Use pre-composed classes for complex components (segment system, buttons, modals)
- Use Tailwind utilities for layout (flex, gap, padding, positioning)

## 10. Do's and Don'ts

### Do
- Use CSS variable tokens for all colors, spacing, shadows, radii, and z-index
- Use the segment system (`.seg-*`) for control panels and grouped settings
- Use weight shifts (400 → 500 → 600) for hierarchy rather than large size jumps
- Use semi-transparent white borders on dark surfaces
- Use solid 0.92+ alpha dark fills (not `backdrop-filter: blur`) for wide floating chrome over the map — see §1 note on Chrome seam
- Use `--ease-out-expo` as the default transition easing
- Use `--duration-*` tokens for animation/transition timing
- Use `--z-*` tokens for all z-index values
- Use `--color-device-*` tokens for device identification colors
- Use `.modal-overlay` + `.modal-dialog` for new modals
- Use `.status-badge-*` for inline action buttons and status indicators
- Use `.separator-v` / `.separator-h` for dividers
- Apply `prefers-reduced-motion` to all animations

### Don't
- Don't hardcode hex colors in components — add to `@theme` tokens
- Don't use inline styles for colors, borders, or shadows — use CSS vars or Tailwind
- Don't use numeric z-index values — always reference `--z-*` tokens
- Don't use font-weight 700 (bold) — the maximum weight in this system is 600
- Don't use box-shadow for elevation alone on dark surfaces — use background luminance stepping
- Don't add new keyframes without a corresponding `.anim-*` utility class
- Don't mix approaches in a single component (Tailwind for layout but inline for colors)
- Don't introduce warm or saturated colors into UI chrome — cool gray with the violet accent only
- Don't use pure `#ffffff` as primary text — always use `--color-text-1` (`#e8eaf0`)
- Don't use Tailwind's semantic color utilities (`text-green-400`, `text-red-400`, `bg-amber-400/15`) — use the `--color-*-text` / `--color-*-dim` tokens instead
- Don't render interactive `<div onClick>` elements — they're invisible to keyboard and assistive tech. Use `<button>` (or wire up `role`, `tabIndex`, and a keyboard handler if a `div` is unavoidable)
- Don't use `--color-accent` for text on an `accent-dim` background — use `--color-accent-strong`

## 11. Remaining Gaps

These items are intentional omissions or lower-priority future work:

| Category | Status | Notes |
|----------|--------|-------|
| Light mode | Intentional omission | This is a dark-mode-only tool UI |
| Geist OpenType features | Not applied | Stylistic sets could be enabled, but not critical for a tool UI |
| Tooltip component | Not defined | No tooltip pattern exists yet; add when needed |
| Dropdown/select component | Not defined | Native selects used; create when custom dropdown is needed |
| Grid system | Not used | Layout is entirely positioned (fixed/absolute) over a full-screen map |
| Max-width constraints | Not needed | Panels use fixed widths appropriate for a desktop tool |
