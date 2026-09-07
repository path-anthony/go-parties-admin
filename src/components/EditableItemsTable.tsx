import { updateItem } from "../lib/api";
import type { Item } from "../lib/types";
import { EditableCell } from "./EditableCell";

export function EditableItemsTable({
  items,
  onItemUpdated,
}: {
  items: Item[];
  onItemUpdated: (item: Item) => void;
}) {
  async function save(item: Item, field: "name" | "category" | "price" | "priceUnit" | "notes" | "photoUrl", value: string) {
    const updated = await updateItem(item.id, { [field]: value });
    onItemUpdated(updated);
  }

  return (
    <div className="table-scroll">
      <table className="items-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Category</th>
            <th>Price</th>
            <th>Price unit</th>
            <th>Notes</th>
            <th>Photo URL</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <EditableCell value={item.name} onSave={(v) => save(item, "name", v)} />
              </td>
              <td>
                <EditableCell value={item.category} onSave={(v) => save(item, "category", v)} />
              </td>
              <td>
                <EditableCell type="number" value={item.price ?? ""} onSave={(v) => save(item, "price", v)} />
              </td>
              <td>
                <EditableCell value={item.priceUnit ?? ""} onSave={(v) => save(item, "priceUnit", v)} />
              </td>
              <td>
                <EditableCell value={item.notes ?? ""} onSave={(v) => save(item, "notes", v)} />
              </td>
              <td>
                <EditableCell
                  value={item.photoUrl ?? ""}
                  placeholder="https://..."
                  onSave={(v) => save(item, "photoUrl", v)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
