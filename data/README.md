# Item import template

`item-import-template.csv` is the format for handing Andy a bulk list of
items to add. Fill in one row per item and send the file back for import.

| Column | Required | Notes |
|---|---|---|
| `name` | yes | Item name as it should appear to customers. |
| `category` | yes | e.g. Inflatables, Games, Entertainment, Photo and Video. Reuse an existing category name where one fits. |
| `price` | no | Numbers only, no `$` or commas (e.g. `475`, not `$475.00`). Leave blank if the price isn't set yet. |
| `price_unit` | no | How the price applies, e.g. `per day`, `per event`, `per hour`, `flat`. Put rate details here too if there's more than one price (e.g. "per day, 650 for weekend"). |
| `notes` | no | Anything else worth knowing: what's included, ownership, condition. |
| `photo_url` | no | Link to a photo, if one exists. Leave blank otherwise. |

Keep the header row exactly as-is. One item per row, no merged cells.
