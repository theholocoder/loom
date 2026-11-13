# One Panel model for the Side area and the Dock

The sidebar (one width for Session info and Changes, saved app-wide) and the Dock (each Session's own open state and height, lost when Loom quits) were two systems. Both become **Panel areas** holding **Panels** of the same model. Each Panel kind registers once with its label, icon, badge, default area and minimum and preferred size. We split the saved state by who it belongs to:

- **The Layout is app-wide and kept across restarts.** That means which area each Panel kind sits in, and each kind's width (in the Side area) or height (in the Dock). The Side area takes the size of the Panel it shows, so Changes can stay at 640px while the Merge request stays at 400px. Every Terminal shares one size.
- **The rest belongs to each Session and is kept in the database.** That means which Panels are open in each area, which one is shown, and whether each area is shown. Terminals still end when Loom quits, so their tabs don't come back. A new Session opens with the default Panels (Changes, with the Side area shown).

We rejected one app-wide set of open Panels because Terminals belong to one Session and a Merge request Panel means nothing on a Session without one. We rejected one size per area because Changes and the Merge request want opposite widths: sharing one width is what broke the old sidebar.

## Layout decisions that come with it

- **The composer spans only the conversation column.** The Side area runs full height, from the Glance strip to the bottom, beside it. The Dock spans the whole Session under both.
- **Review mode hides the Side area** while it's on. The reviewed Panel is the Side area's content, so keeping both would mean three columns. Leaving review mode (Esc or ⤢) brings the Side area back as it was.
- **Below 1100px the Side area becomes an overlay drawer** over the conversation, with a scrim. It closes when you click outside, press Esc or open another Session. The Dock doesn't change.
- **Tab overflow:** the active tab always keeps its label. When tabs don't fit, the inactive ones drop to icon and badge (with a tooltip) first. Those that still don't fit go into a ⌄ menu, last tab first.

`docs/prototypes/side-panels.html` shows all of this.

## Split areas (#193)

Either area can be split into two **Panel stacks**: the Side area's one above the other, the Dock's side by side. Which stack each kind sits in is part of the Layout, like its area, so a split holds in every Session: an area shows as split only while both its stacks have Panels open. A tab moves between areas and stacks from its menu, or by dragging it. As every Panel of a kind sits in one place, an area splits only with Panels of two kinds in it: a Dock of Terminals alone can't be split.

We kept one size per kind rather than adding a split ratio. A split area takes the larger of its two shown Panels' sizes across it, and dragging its edge sizes both. Its second stack takes the size of the Panel it shows along the area (its height in the Side area, its width in the Dock), which each kind already has from sitting in the other area.
