# Plasma Design System — TelegramEnchanted

This document is the authoritative reference for the visual design of TelegramEnchanted.
All AI-assisted work on this project must consult this document before proposing UI changes.

---

## Overview

TelegramEnchanted uses the **Plasma** design system — a dark, dense, gamer/community aesthetic
inspired by productivity messaging apps. The system lives entirely in `src/renderer/index.css`
(global tokens and component styles) and `src/renderer/Dashboard.css` (Telegram-specific additions).

---

## Color System

Colors use **OKLCH** (perceptual color space). This is a modern CSS feature well-supported
in Chromium/Electron. Never use hex or HSL for design tokens — always OKLCH.

### Palettes

Four switchable palettes. The user switches via the rail or the ⋮ menu.
The active palette is set as `data-palette="<name>"` on the `.app` root element.

| Palette | Base Hue | Accent | `data-palette` |
|---------|----------|--------|----------------|
| **Ion** (default) | Blue-black (250°) | Electric cyan `oklch(0.80 0.16 220)` | `ion` |
| **Ember** | Warm brown (40°) | Amber `oklch(0.78 0.17 55)` | `ember` |
| **Bloom** | Deep magenta (320°) | Fuchsia `oklch(0.74 0.20 330)` | `bloom` |
| **Forest** | Dark teal (165°) | Mint `oklch(0.78 0.14 155)` | `forest` |

### Background Levels

Each palette defines 4 background levels (darkest → lightest):

```css
--bg-0  /* deepest — app background, rail */
--bg-1  /* sidebar/list background */
--bg-2  /* surface — cards, inputs, dropdowns */
--bg-3  /* raised — hover states, chips */
--bg-hover   /* translucent hover overlay */
--bg-active  /* translucent active/selected overlay */
```

### Text Levels

```css
--text-0  /* primary — near white, main content */
--text-1  /* secondary — readable body text */
--text-2  /* tertiary — labels, subtitles */
--text-3  /* muted — timestamps, hints */
```

### Accent

```css
--accent       /* main accent color */
--accent-soft  /* 18% opacity accent — backgrounds, borders */
--accent-text  /* text color ON accent backgrounds */
--accent-glow  /* 45% opacity accent — shadows, glows */
```

### User Colors (avatars, name colors)

```css
--u-rose    --u-violet   --u-cyan    --u-amber
--u-emerald --u-fuchsia  --u-sky
```

Used as `.color-rose`, `.color-violet`, etc. on avatar and sender name elements.
Color assignment is deterministic: `hashColor(chatId)` maps an ID to one of 7 colors.

### Semantic Colors

```css
--danger  /* oklch(0.70 0.18 20) — red */
--warn    /* oklch(0.78 0.16 75) — amber */
--good    /* oklch(0.78 0.14 155) — green */
--idle    /* oklch(0.78 0.13 75) — yellow */
```

---

## Typography

```css
--font-sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
```

Base: `font-size: 14px; line-height: 1.45; letter-spacing: -0.005em`

Key type scales:
- List title: `17px / 600 / -0.02em`
- Chat name: `14px / 500`
- Message sender: `14px / 600 / -0.005em`
- Message text: `14px / 1.5`
- Timestamps: `11px / tabular-nums`
- Labels/caps: `11px / 600 / 0.06em / uppercase`

---

## Layout — 4-Column Grid

```css
.app {
  display: grid;
  grid-template-columns: var(--rail-w) var(--list-w) minmax(360px, 1fr) auto;
  height: 100vh;
}
```

| Column | Width | CSS var | Element |
|--------|-------|---------|---------|
| Rail | 72px | `--rail-w` | `.rail` — icon strip |
| List | 304px | `--list-w` | `.list` — chat list |
| Convo | flex | — | `.convo` — conversation |
| Info | 320px | `--info-w` | `.info` — right panel (toggle) |

The info panel hides at `max-width: 1180px`.

---

## Density

Three modes set as `data-density="<mode>"` on the `.app` element:

| Mode | `--row-h` | `--msg-gap` | `--msg-pad-y` |
|------|-----------|-------------|---------------|
| compact | 52px | 8px | 5px |
| cozy (default) | 60px | 14px | 8px |
| roomy | 72px | 22px | 12px |

---

## Border Radii

```css
--radius-sm: 6px   /* small chips, badges */
--radius:    10px  /* standard cards, rows */
--radius-lg: 14px  /* large panels, modals */
--radius-xl: 22px  /* pills */
```

---

## Components

### `.rail` — Left icon strip

- 72px wide, `--bg-0` background, border-right soft line
- `.rail-brand-mark` — gradient square, 36px, rounded 10px, shows "TE"
- `.rail-item` — 48×48 clickable slot with `.indicator` (accent left bar)
- `.rail-tile` — 44×44 rounded square inside each item
- `.rail-divider` — 1px horizontal rule
- States: `.active` (indicator + tile glows), `.has-unread` (taller indicator), `.idle` (no indicator)

### `.list` — Chat list panel

Structure:
```
.list
  .list-header
    .list-title h1 + .list-title-actions (.icon-btn×n)
    .search (conditional)
  .folders (.folder×n)
  .chats (.chat-row×n)
  .user-card
```

#### `.chat-row`

Grid: `44px 1fr auto` × 2 rows, height `--row-h`.
- `.chat-avatar.color-X` — 40px circle, color from `hashColor(chatId)`
- `.chat-name .name-text` — truncated chat name
- `.chat-preview` — subtext/type
- `.chat-meta` — timestamp (right column)
- States: `.active` (accent left bar + `--bg-active`), `.unread` (accent badge)

### `.convo` — Conversation column

Structure:
```
.convo
  .convo-header (56px, border-bottom)
    .who (.who-avatar + .who-text)
    .convo-header-actions (.icon-btn×n + .dropdown-menu)
  .convo-panels (download panel, create-topic form)
  .timeline (flex-1, scrollable) — OR — .topic-list-panel
  .composer-wrap
```

#### `.convo-header`

Always 56px tall. `.who-avatar` is 36px circle. `.who-name` is `15px / 600`.

#### `.timeline` — Message list

```
.timeline (flex column, gap: --msg-gap, overflow-y: auto)
  .day-divider (.line + .label + .line)
  .msg-row (.msg-avatar + .msg-body)
  .msg-row.continued (avatar hidden, no header)
```

**`.msg-row`** grid: `56px 1fr`
- `.msg-avatar.color-X` — 40px circle with 2-letter initials
- `.msg-body > .msg-head > .msg-from.color-X + .msg-time`
- `.msg-body > .msg-text` — `white-space: pre-wrap`
- `.msg-row.self` — sender color is `--u-cyan` (outgoing)
- `.msg-row.continued` — collapses top padding, hides avatar & head
- Hover: time-inline appears for continued rows

#### `.composer-wrap`

```
.composer-wrap (padding: 0 24px 18px)
  .composer (bg-2, border line-soft, radius-lg, focus-within glow)
    .reply-strip (optional, border-bottom)
    .composer-file-chip (optional)
    .composer-progress (3px bar)
    .composer-main (grid: auto 1fr auto)
      .composer-tools (.icon-btn×n)
      textarea
      .composer-send (36px, accent bg, send icon)
```

### `.info` — Right info panel

Collapsed by default (`data-collapsed="true"` → `display: none`).
Contains `.info-header`, `.info-hero` (84px avatar + name + sub), `.info-section`×n.

### `.icon-btn`

Universal 32×32 icon button. `border-radius: 8px`.
- Default: `color: --text-2`, transparent bg
- Hover: `--bg-hover`, `--text-0`
- Active: `--accent-soft`, `--accent`

### `.dropdown-menu`

Positioned absolutely below its trigger.
```css
background: var(--bg-2);
border: 1px solid var(--line);
border-radius: var(--radius);
box-shadow: 0 8px 24px -8px rgba(0,0,0,0.45);
```

`.dropdown-item`: 8px×12px padding, hover `--bg-hover`.
`.dropdown-divider`: 1px line in `--line-soft`.

### `.context-menu`

Portal-rendered (React createPortal → document.body).
Uses `.glass-panel` equivalent: `--bg-2` bg, `--line` border, shadow.
`.context-menu-item` — same hover pattern as dropdown-item.

---

## Telegram-Specific Components (Dashboard.css)

### Download Panel (`.inline-download-panel`)

Shown inside `.convo-panels` (between header and content).
- `--bg-2`, border `--line`, `--radius-lg`, slide-down animation
- Folder picker: `.folder-selection` (flex row: input + browse button)
- Topic dropdown: `.custom-select` + `.custom-select-options`
- Progress: `.progress-bar > .progress-fill` + `.animated-stripes` class

### Topic List (`.topic-list-panel`)

Replaces the timeline when a forum group is selected without a topic.
- `.topic-item` — flex row: avatar (44px) + content
- `.topic-item-avatar` — `--radius` rounded, gradient background
- `.topic-item-avatar-all` — accent gradient (for "All topics" entry)

### Create Topic Form (`.new-topic-form`)

Shown above topic list.
- Text input + color picker dots + Criar button
- Color options use TOPIC_ICON_COLORS constant (Telegram forum icon colors)

### Progress Bar

```css
.progress-bar > .progress-fill
.progress-fill.animated-stripes   /* active download */
.progress-fill.scanning-fill      /* scanning phase */
```

---

## Color Assignment Algorithm

```typescript
const PLASMA_COLORS = ['rose', 'violet', 'cyan', 'amber', 'emerald', 'fuchsia', 'sky'];
const hashColor = (str: string): PlasmaColor => {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) & 0x7fffffff;
  return PLASMA_COLORS[Math.abs(h) % PLASMA_COLORS.length];
};
```

Use this for:
- Chat avatar color: `hashColor(chat.id)`
- Message sender color: `hashColor(msg.senderId || msg.id.toString())`
- Outgoing messages: always `'cyan'`

---

## Key CSS Variables Map (Old → Plasma)

If migrating code that used the old glass theme:

| Old var | Plasma equivalent |
|---------|-------------------|
| `--bg-surface` | `var(--bg-2)` |
| `--bg-surface-hover` | `var(--bg-3)` |
| `--text-primary` | `var(--text-0)` |
| `--text-secondary` | `var(--text-1)` |
| `--text-muted` | `var(--text-2)` |
| `--accent-primary` | `var(--accent)` |
| `--accent-subtle` | `var(--accent-soft)` |
| `--border-subtle` | `1px solid var(--line-soft)` |
| `--radius-md` | `var(--radius)` |
| `--radius-pill` | `999px` |
| `--transition-fast` | `0.15s ease-out` |
| `--danger-bg` | `color-mix(in oklch, var(--danger) 14%, transparent)` |

---

## Files

| File | Purpose |
|------|---------|
| `src/renderer/index.css` | Full Plasma design system (tokens, layout, components) |
| `src/renderer/Dashboard.css` | Telegram-specific additions (download, topics, context menu) |
| `src/renderer/App.css` | Login screen only (scoped to `.login-form`) |
| `src/renderer/Dashboard.tsx` | Main app shell — layout rendered with Plasma classes |
| `src/renderer/ChatAvatar.tsx` | Loads real Telegram profile photos; fallback to initials |
| `src/renderer/MessageMedia.tsx` | Photo/video viewer with streaming and lightbox |
| `src/renderer/ContextMenu.tsx` | Portal-based context menu (reply, copy text) |
