---
version: "alpha"
name: Router Workspace
description: Compact operator-first dashboard styling for Project Router. The system is warm, restrained, and dense enough for admin work without turning into card soup.
colors:
  primary: "#D97757"
  primary-hover: "#C56243"
  bg-light: "#FBF9F6"
  bg-dark: "#191918"
  surface-light: "#FFFFFF"
  surface-dark: "#242423"
  border-light: "#E6E4DD"
  border-dark: "#333331"
  text-main-light: "#383733"
  text-main-dark: "#ECEBE8"
  text-muted-light: "#75736E"
  text-muted-dark: "#9E9D99"
  danger: "#EF4444"
  success: "#16A34A"
  info: "#2563EB"
typography:
  title-lg:
    fontFamily: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  body-md:
    fontFamily: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  label-sm:
    fontFamily: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif
    fontSize: 0.75rem
    fontWeight: 500
    lineHeight: 1.4
  meta-xs:
    fontFamily: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.3
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
components:
  card-base:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.text-main-light}"
    rounded: "{rounded.lg}"
    padding: 24px
  card-section:
    backgroundColor: "{colors.bg-light}"
    textColor: "{colors.text-main-light}"
    rounded: "{rounded.md}"
    padding: 16px
  collection-row:
    backgroundColor: "{colors.bg-light}"
    textColor: "{colors.text-main-light}"
    rounded: "{rounded.md}"
    padding: 16px
  collection-row-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.text-main-light}"
    rounded: "{rounded.md}"
    padding: 16px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    height: 36px
    padding: 16px
  button-secondary:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.text-main-light}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 16px
  button-ghost:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.text-muted-light}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 12px
  menu-surface:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.text-main-light}"
    rounded: "{rounded.md}"
    padding: 8px
  modal-surface:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.text-main-light}"
    rounded: "{rounded.xl}"
    padding: 24px
---

## Overview

This design system is for operational product UI, not marketing. The interface should feel like a warm macOS admin tool: calm cream background, white working surfaces, terracotta as the only strong action color, and dense but readable information. Every screen should bias toward the working surface itself rather than explanatory banners.

The collections page is the canonical example of the style. One narrow control rail on the left. One main work pane on the right. Operators should understand the page by scanning titles, row labels, and actions without reading a paragraph.

## Colors

The palette is warm and restrained.

- **Primary (`#D97757`)** is the only assertive accent. Use it for selected state, primary actions, and focused emphasis. Do not introduce extra accent hues when the existing neutral hierarchy is enough.
- **Background light (`#FBF9F6`)** is a soft paper tone, not pure white. It keeps the app from looking sterile.
- **Surface light (`#FFFFFF`)** is reserved for active working surfaces such as cards, menus, and modals.
- **Text main light (`#383733`)** is the default foreground. It should carry nearly all reading weight.
- **Text muted light (`#75736E`)** is for metadata, counts, inactive controls, and empty-state copy.
- **Danger (`#EF4444`)** is only for destructive actions and delete affordances.

Use dark-mode values as direct counterparts, not as a new mood. The dark theme should preserve the same warmth and restraint, only translated into darker surfaces and softer borders.

## Typography

Use the system San Francisco style stack already defined in the app. The tone is operational and native, not branded or editorial.

- Titles are compact, semibold, and slightly tightened.
- Body text stays small and clear.
- Metadata should be visibly quieter than primary labels.
- Avoid oversized headings on tool pages. If a title feels like a hero, it is probably wrong.

Text hierarchy should come from weight and contrast first, size second.

## Layout

Prefer a two-pane workspace for operator flows:

- **Left rail:** selection, navigation within the feature, compact actions.
- **Right pane:** the current working set and the next action.

For this app, the collections page should stay compact:

- No intro banners for routine CRUD pages.
- No explanatory cards unless the user cannot operate the surface without them.
- No duplicated control surfaces for the same concept.
- The primary list should stretch to fill available height when it is the navigation anchor for the page.

Spacing should feel tight but breathable. Use `8px`, `12px`, `16px`, and `24px` as the dominant rhythm. Avoid random micro-adjustments that make the UI feel improvised.

## Elevation & Depth

Depth is subtle and mostly border-driven.

- Standard cards use low-contrast borders and light shadow.
- Menus and modals can use stronger shadow to read as overlays.
- Hover states should tint or shift contrast slightly, not jump.
- Selected rows use a quiet primary tint rather than a fully different layout treatment.

Do not stack decorative surfaces just to create hierarchy. The hierarchy should come from layout responsibility first.

## Shapes

Rounded corners are soft but controlled.

- Small controls and icon buttons: `6px`
- Rows, inputs, badges, and menus: `8px`
- Cards: `12px`
- Modals: `16px`

Avoid overly round pills unless the component is already defined as a badge or chip.

## Components

These rules should guide future screens in this workspace.

**Cards**

- A card should exist only when it defines a real working region.
- Do not create separate cards for explanation, rename, routing notes, and list content when one or two working surfaces can carry the task.
- Titles and subtitles should be short utility copy, not commentary.

**Collection rows**

- A collection row is a compact object: name, member count, optional state badge, optional overflow menu.
- Row-level actions belong behind the overflow trigger, not in a separate management panel.
- Inline rename is acceptable inside the selected row when it replaces a separate form.

**Buttons**

- Primary button: terracotta fill, white text, used for the current commit action.
- Secondary button: white surface, bordered, low emphasis.
- Ghost button: for overflow actions, inline cancel, or quiet utilities.
- Icon-only buttons are preferred when the action is obvious from context, such as add, more, or delete.

**Menus**

- Use small, surface-colored contextual menus for row actions.
- Menu copy should be terse: `Rename`, `Delete`, `Add`, `Remove`.
- The menu should feel like an extension of the row, not a new panel.

**Modals**

- Use modals for short, interruptive tasks: create collection, pick connections, confirm delete.
- Keep forms to one job per modal.
- Modal bodies should stay compact and action-oriented.

**Member lists**

- Show only the current members in the main pane.
- Removal should be immediate and local to each row.
- Addition should happen through an explicit picker, not by rendering the entire universe with checkboxes inline.

## Do's and Don'ts

**Do**

- Keep operator pages compact and task-first.
- Let the list and current working set dominate the screen.
- Use one accent color with discipline.
- Prefer row actions, menus, and modals over permanent management chrome.
- Treat subtitles as utility hints, not as mini-docs.

**Don't**

- Don’t add intro cards to routine admin pages.
- Don’t reserve full cards for single low-frequency actions like rename.
- Don’t explain obvious UI structures with filler copy.
- Don’t show global system implications on a collections page unless they are directly actionable there.
- Don’t render “all available things” inline when the job is “show current members.”
