# Item import template

`item-import-template.csv` is the format Inventory's "Bulk add items"
reads (the admin's Download template gives the same file). Fill in one
row per item, then upload it there: the preview shows every row and
names any problem before anything is created.

| Column | Required | Notes |
|---|---|---|
| `name` | yes | Item name as it should appear to customers. |
| `category` | yes | e.g. Inflatables, Games, Entertainment, Photo and Video. Reuse an existing category name where one fits. |
| `price` | yes | Numbers only, no `$` or commas (e.g. `475`, not `$475.00`). |
| `billed_per` | no | How the price reads to a customer, e.g. `per day`, `per event`, `per hour`. |
| `skills` | no | Crew skills the item needs, comma-separated, from: DJ/MC, Photographer, Videographer, Photo Booth Attendant, Day-of Coordinator, Waitstaff, Bartender, Live Musician. Blank for a physical item. |
| `starting_units` | no | How many real pieces exist today. Blank means 1. Ignored when `skills` is set (a service item is covered by crew). |
| `notes` | no | Anything else worth knowing: what's included, ownership, condition. |

Keep the header row exactly as-is. One item per row, no merged cells. A row whose name already exists in the catalog is skipped, so a file can be re-uploaded safely. Categories are matched to existing ones regardless of case; a new one is created as typed.
