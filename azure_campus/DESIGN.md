# Design System Document: Campus Editorial

## 1. Overview & Creative North Star
### The Creative North Star: "The Digital Commons"
This design system moves beyond the generic "utility app" feel to create a space that feels like a premium, curated university publication. We are not building a sterile database; we are building a "Digital Commons"—a warm, safe, elevated environment for student expression.

To break the "template" look common in WeChat Mini Programs, we utilize **Intentional Asymmetry** and **Editorial Breathing Room**. By leveraging a high-contrast typography scale (pairing the geometric authority of *Plus Jakarta Sans* with the approachable clarity of *Be Vietnam Pro*), we create a sense of trust and sophistication. The layout should feel like a well-designed physical bulletin board: layered, tactile, and human.

---

## 2. Colors & Surface Philosophy
The palette is rooted in a "Campus Blue" that feels authoritative yet academic, supported by a sophisticated range of neutrals that provide depth without visual noise.

### The "No-Line" Rule
**Borders are strictly prohibited for sectioning.** To define boundaries, designers must use background color shifts or tonal transitions. For example, a `surface-container-low` section should sit directly against a `surface` background. This creates a modern, "unboxed" feel that reduces cognitive load.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. Use the following tiers to define importance:
- **Base Layer:** `surface` (#f7f9fc) for the main application background.
- **Section Layer:** `surface-container-low` (#f0f4f8) for grouping related content blocks.
- **Focus Layer:** `surface-container-lowest` (#ffffff) for the primary interactive cards or "tree hole" posts. This "white-on-tint" approach makes content pop naturally.

### The "Glass & Gradient" Rule
To add soul to the "Trustworthy" brand pillar, use **Glassmorphism** for floating elements (like bottom navigation bars or sticky headers). Apply `surface` at 80% opacity with a `backdrop-blur: 20px`. 
- **Signature Texture:** For primary Action Buttons or Hero Headers, use a linear gradient: `primary` (#426089) to `primary-dim` (#35547d). This prevents the UI from feeling "flat" and adds professional polish.

---

## 3. Typography
We use a dual-typeface system to balance "Youthful Energy" with "Academic Trust."

*   **Display & Headlines (Plus Jakarta Sans):** Used for large headers and category titles. Its geometric nature feels modern and confident.
    *   `display-md` (2.75rem): For major welcome moments.
    *   `headline-sm` (1.5rem): For section headers.
*   **Body & Labels (Be Vietnam Pro):** Optimized for long-form reading in a mobile environment. Its slightly warmer terminals make the "tree hole" feel intimate and safe.
    *   `body-lg` (1rem): For primary post content.
    *   `label-md` (0.75rem): For metadata like timestamps and tags.

---

## 4. Elevation & Depth
Depth in this system is a result of **Tonal Layering**, not structural scaffolding.

*   **The Layering Principle:** Avoid shadows where possible. Instead, place a `surface-container-lowest` card on a `surface-container` background. The subtle 2-3% difference in value provides a "soft lift."
*   **Ambient Shadows:** If a card requires a floating state (e.g., a "New Post" button), use an extra-diffused shadow:
    *   `box-shadow: 0 12px 32px rgba(44, 51, 56, 0.06);` (Using a tinted version of `on-surface`).
*   **The "Ghost Border" Fallback:** If a layout absolutely requires a separator (e.g., in a high-density list), use the `outline-variant` (#abb3b9) at **15% opacity**. Never use 100% opaque lines.

---

## 5. Components

### Cards & Feed Items
*   **Style:** Use `rounded-xl` (1.5rem) for main feed cards to emphasize the "friendly/safe" feel. 
*   **Constraint:** Forbid divider lines within cards. Separate the "Post Header," "Content," and "Actions" using `spacing-4` (1.4rem) of vertical white space.
*   **Social Icons:** Use "Soft-Stroke" icons. Interaction states (Like/Comment) should transition from `outline` to `primary` with a subtle scale-up animation (1.05x).

### Buttons
*   **Primary:** `primary` background with `on-primary` text. Use `rounded-full` for a youthful, pill-shaped aesthetic.
*   **Secondary:** `secondary-container` background with `on-secondary-container` text. No border.
*   **Tertiary:** Transparent background with `primary` text. Used for "Cancel" or "Report" actions to reduce visual weight.

### Input Fields
*   **Style:** `surface-container-highest` background with a `rounded-md` (0.75rem) corner. 
*   **Focus State:** Shift background to `surface-container-lowest` and add a 2px "Ghost Border" using `primary` at 20% opacity.

### Signature Component: The "Tree Hole" Bubble
*   For anonymous posts, use a `tertiary-container` (#d8cafc) background with a gentle organic shape (irregular border-radius: `24px 24px 8px 24px`). This visually distinguishes "safe/private" thoughts from "public bulletin" posts.

---

## 6. Do’s and Don’ts

### Do
*   **Do** use asymmetrical margins (e.g., a wider left margin for headlines) to create an editorial feel.
*   **Do** leverage `surface-tint` for subtle background glows behind featured content.
*   **Do** ensure all interactive targets meet a 44px minimum height for mobile accessibility.

### Don’t
*   **Don’t** use pure black (#000000) for text. Always use `on-surface` (#2c3338) to maintain the "warm" atmosphere.
*   **Don’t** use 1px solid borders. They break the soft, "Digital Commons" aesthetic.
*   **Don’t** crowd the interface. If in doubt, increase the spacing by one tier on the Spacing Scale.