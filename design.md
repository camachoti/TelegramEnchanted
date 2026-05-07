# Telegram Enchanted - Design System Guide (DesignCode UI)

This document outlines the standardized CSS architecture and design tokens required to implement the DesignCode UI aesthetic across the Telegram Enchanted application. 

The goal is to move away from one-off, hardcoded styles and adopt a robust, token-based system that ensures consistency across light and dark themes while maintaining a premium, glassmorphic look.

## 1. Design Philosophy

DesignCode UI is characterized by:
*   **Glassmorphism**: Extensive use of `backdrop-filter: blur()`, semi-transparent backgrounds, and subtle borders to create depth.
*   **Vibrant Gradients**: Mesh gradients for backgrounds and linear gradients for primary accents (buttons, active states).
*   **Soft Geometry**: Generous border radii (`16px`, `20px`, `999px` for pills) and smooth, non-bouncy transitions.
*   **High Contrast Typography**: Clear hierarchy with muted secondary text and bright/dark primary text depending on the theme.

## 2. CSS Architecture

We will organize our CSS into clearly defined layers within `index.css` and use component-specific files (like `Dashboard.css`) only for layout and highly specialized elements.

1.  **Tokens (`:root` and `.light-theme`)**: The source of truth for all colors, spacing, and typography.
2.  **Base (`*`, `body`)**: Resets and global typography settings.
3.  **Utility Components**: Standardized classes for buttons, inputs, cards, and glass panels.

## 3. Design Tokens (CSS Variables)

These variables must be used exclusively. Hardcoded colors (e.g., `#ffffff`, `rgba(0,0,0,0.5)`) are forbidden in component styles.

### 3.1 Colors (Dark Theme - Default `:root`)
```css
:root {
  /* Backgrounds */
  --bg-app: #0f1115; /* Deep, dark app background */
  --bg-surface: rgba(30, 33, 40, 0.7); /* Standard glass card */
  --bg-surface-hover: rgba(45, 50, 60, 0.8);
  --bg-overlay: rgba(15, 17, 21, 0.85); /* For modals/lightboxes */
  
  /* Borders */
  --border-subtle: 1px solid rgba(255, 255, 255, 0.08);
  --border-focus: 1px solid rgba(139, 92, 246, 0.5); /* Purple focus */

  /* Typography */
  --text-primary: #ffffff;
  --text-secondary: rgba(255, 255, 255, 0.6);
  --text-muted: rgba(255, 255, 255, 0.4);

  /* Accents & Gradients */
  --accent-primary: #8b5cf6; /* Vibrant Purple */
  --accent-gradient: linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%);
  --accent-subtle: rgba(139, 92, 246, 0.15);
  
  /* Status */
  --danger: #ef4444;
  --danger-bg: rgba(239, 68, 68, 0.15);
}
```

### 3.2 Colors (Light Theme - `.light-theme`)
```css
.light-theme {
  --bg-app: #f8fafc; /* Very light slate/blueish white */
  --bg-surface: rgba(255, 255, 255, 0.7);
  --bg-surface-hover: rgba(255, 255, 255, 0.9);
  --bg-overlay: rgba(255, 255, 255, 0.6);
  
  --border-subtle: 1px solid rgba(0, 0, 0, 0.06);
  --border-focus: 1px solid rgba(139, 92, 246, 0.4);

  --text-primary: #0f172a;
  --text-secondary: #64748b;
  --text-muted: #94a3b8;

  --accent-primary: #7c3aed;
  /* Gradient remains the same or slightly adjusted for light mode */
  --accent-subtle: rgba(124, 58, 237, 0.1);
}
```

### 3.3 Geometry & Motion
```css
:root {
  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-pill: 99px;

  /* Smooth, non-bouncy transitions */
  --transition-fast: 0.15s ease-out;
  --transition-med: 0.3s ease-out;
  
  /* Standardized Glass Shadows */
  --shadow-glass: 0 8px 32px rgba(0, 0, 0, 0.12);
  --shadow-float: 0 12px 40px rgba(0, 0, 0, 0.2);
}

.light-theme {
  --shadow-glass: 0 8px 32px rgba(0, 0, 0, 0.06);
  --shadow-float: 0 12px 40px rgba(0, 0, 0, 0.1);
}
```

## 4. Standardized Component Classes

To avoid rewriting styles, we will use these standardized classes across the React components.

### Panels & Cards
*   `.glass-panel`: Standard container with `var(--bg-surface)`, `backdrop-filter: blur(20px)`, `border-radius: var(--radius-lg)`, and `var(--border-subtle)`. Used for the sidebar, main chat area, and modals.

### Buttons
All buttons will use a base `.btn` class, modified by variants.
*   `.btn`: Base styles (padding, font-weight, flex center, border: none, cursor, transition).
*   `.btn-primary`: Uses `--accent-gradient`, white text, and a glowing shadow. (Hover: brightness increase).
*   `.btn-secondary`: Uses `--bg-surface`, `--border-subtle`, and `--text-primary`. (Hover: `--bg-surface-hover`).
*   `.btn-danger`: Red gradient/solid, white text.
*   `.btn-icon`: Circular or square button specifically for icons, using subtle hover backgrounds.

### Form Elements (Inputs & Selects)
*   `.input-glass`: Standard text input. Uses a very subtle semi-transparent background (`rgba(0,0,0,0.2)` in dark, `rgba(255,255,255,0.5)` in light), `--border-subtle`, and applies `--border-focus` on focus.
*   `.select-glass`: Standard dropdown trigger matching the `.input-glass` aesthetic.

### Typography Utilities
*   `.text-title`: `font-weight: 600`, `font-size: 20px`, `color: var(--text-primary)`.
*   `.text-body`: Standard size, `color: var(--text-secondary)`.
*   `.text-caption`: `font-size: 12px`, `color: var(--text-muted)`.

## 5. Implementation Rules

1.  **No direct color values** in `Dashboard.css` or component inline styles.
2.  **Use `backdrop-filter` responsibly**: Apply it only to `.glass-panel` components or overlays to avoid performance hits.
3.  **Global Background**: The `.dashboard-container` will hold the main background (a mesh gradient or a deep solid color), and all child elements will be semi-transparent glass layers floating on top.
