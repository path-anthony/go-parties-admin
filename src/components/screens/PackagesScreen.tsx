import { type FormEvent, useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import {
  createPackage,
  deletePackage,
  getItems,
  getPackages,
  publishPackage,
  suggestPackageKeywords,
  unpublishPackage,
  updatePackage,
} from "../../lib/api";
import { OCCASION_GROUPS } from "../../lib/occasions";
import { isUploadedPhoto } from "../../lib/photo";
import type { Item, Package, PackageInput, PackageStatus } from "../../lib/types";
import { PhotoDropZone } from "../PhotoDropZone";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

type Filter = "All" | PackageStatus;

// Sum of the items' own prices times quantity; items with no price are
// counted separately so the comparison is honest about what it covers.
function itemsSum(rows: { quantity: number; item: { price: string | null } }[]) {
  let sum = 0;
  let unpriced = 0;
  for (const row of rows) {
    if (row.item.price === null) unpriced += 1;
    else sum += Number(row.item.price) * row.quantity;
  }
  return { sum, unpriced };
}

export function PackagesScreen() {
  const [packages, setPackages] = useState<Package[] | null>(null);
  const [catalog, setCatalog] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("All");
  const [modal, setModal] = useState<{ mode: "create" } | { mode: "edit"; pkg: Package } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([getPackages(), getItems()])
      .then(([list, items]) => {
        setPackages(list);
        setCatalog(items);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  function replace(updated: Package) {
    setPackages((prev) => (prev ?? []).map((p) => (p.id === updated.id ? updated : p)));
  }

  async function toggleStatus(pkg: Package) {
    setRowErrors((prev) => ({ ...prev, [pkg.id]: "" }));
    try {
      replace(pkg.status === "Published" ? await unpublishPackage(pkg.id) : await publishPackage(pkg.id));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [pkg.id]: err instanceof Error ? err.message : "Couldn't change status" }));
    }
  }

  const visible = (packages ?? []).filter((p) => filter === "All" || p.status === filter);

  return (
    <div className="screen screen-wide">
      <div className="screen-head screen-head-row">
        <div>
          <h2>Packages & Themes</h2>
          <p className="muted">Curated bundles of real catalog items at one price. Drafts stay private until you publish them.</p>
        </div>
        {packages && (
          <button type="button" className="btn-primary" onClick={() => setModal({ mode: "create" })}>
            New package
          </button>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {!packages && !error && <p className="muted">Loading…</p>}

      {packages && (
        <section className="panel">
          <div className="filter-row">
            {(["All", "Draft", "Published"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={filter === f ? "btn-primary" : "btn-secondary"}
                onClick={() => setFilter(f)}
              >
                {f}
                {f !== "All" && ` (${packages.filter((p) => p.status === f).length})`}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="muted">{packages.length === 0 ? "Nothing here yet." : "No packages match."}</p>
          ) : (
            <div className="table-scroll">
              <table className="items-table scheduling-table">
                <thead>
                  <tr>
                    <th aria-label="Photo" />
                    <th>Name</th>
                    <th>Occasions</th>
                    <th>Items</th>
                    <th>Bundle price</th>
                    <th>Items add up to</th>
                    <th>Status</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((pkg) => {
                    const { sum, unpriced } = itemsSum(pkg.items);
                    return (
                      <tr key={pkg.id}>
                        <td className="catalog-thumb-cell">
                          {pkg.photoUrl ? (
                            <img className="catalog-thumb" src={pkg.photoUrl} alt="" />
                          ) : (
                            <span className="catalog-thumb catalog-thumb-empty" />
                          )}
                        </td>
                        <td>
                          <div className="catalog-name">{pkg.name}</div>
                          {pkg.keywords.length > 0 && <div className="muted">{pkg.keywords.join(", ")}</div>}
                        </td>
                        <td>{pkg.occasions.length > 0 ? pkg.occasions.join(", ") : <span className="muted">Not set</span>}</td>
                        <td>{pkg.items.reduce((n, row) => n + row.quantity, 0)}</td>
                        <td>
                          <strong>{usd(Number(pkg.price))}</strong>
                        </td>
                        <td>
                          {usd(sum)}
                          {unpriced > 0 && <span className="muted"> + {unpriced} TBD</span>}
                        </td>
                        <td>
                          <span className={pkg.status === "Published" ? "status-pill status-pill-live" : "status-pill"}>
                            {pkg.status}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button type="button" className="btn-secondary" onClick={() => setModal({ mode: "edit", pkg })}>
                              Edit
                            </button>
                            <button type="button" className="btn-secondary" onClick={() => toggleStatus(pkg)}>
                              {pkg.status === "Published" ? "Unpublish" : "Publish"}
                            </button>
                          </div>
                          {rowErrors[pkg.id] && <p className="form-error booking-row-error">{rowErrors[pkg.id]}</p>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {modal && (
        <PackageModal
          pkg={modal.mode === "edit" ? modal.pkg : null}
          catalog={catalog}
          onClose={() => setModal(null)}
          onSaved={(saved) => {
            setPackages((prev) => {
              const list = prev ?? [];
              return list.some((p) => p.id === saved.id) ? list.map((p) => (p.id === saved.id ? saved : p)) : [saved, ...list];
            });
            setModal(null);
          }}
          onDeleted={(id) => {
            setPackages((prev) => (prev ?? []).filter((p) => p.id !== id));
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

type ChosenItem = { item: Item; quantity: number };

function toInput(pkg: Package | null): PackageInput {
  return {
    name: pkg?.name ?? "",
    description: pkg?.description ?? "",
    keywords: pkg?.keywords ?? [],
    occasions: pkg?.occasions ?? [],
    price: pkg?.price ?? "",
    photoUrl: pkg?.photoUrl ?? "",
    items: pkg?.items.map((row) => ({ itemId: row.itemId, quantity: row.quantity })) ?? [],
  };
}

// Create and edit live in a popup, per Andy. Everything about the package
// is edited here; publishing stays a separate button on the list.
function PackageModal({
  pkg,
  catalog,
  onClose,
  onSaved,
  onDeleted,
}: {
  pkg: Package | null;
  catalog: Item[];
  onClose: () => void;
  onSaved: (pkg: Package) => void;
  onDeleted: (id: string) => void;
}) {
  const [form, setForm] = useState<PackageInput>(() => toInput(pkg));
  const [chosen, setChosen] = useState<ChosenItem[]>(() =>
    (pkg?.items ?? [])
      .map((row) => ({ item: catalog.find((i) => i.id === row.itemId), quantity: row.quantity }))
      .filter((c): c is ChosenItem => c.item !== undefined),
  );
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);

  function addKeyword(raw: string) {
    const text = raw.trim();
    if (!text) return;
    setForm((f) => (f.keywords.some((k) => k.toLowerCase() === text.toLowerCase()) ? f : { ...f, keywords: [...f.keywords, text] }));
    setKeywordDraft("");
  }

  function toggleOccasion(occ: string, on: boolean) {
    setForm((f) => ({ ...f, occasions: on ? [...new Set([...f.occasions, occ])] : f.occasions.filter((o) => o !== occ) }));
  }

  // Asks for suggestions from what the form holds right now, adds the
  // new ones as tags to edit, saves nothing.
  async function handleSuggest() {
    setSuggesting(true);
    setSuggestNote(null);
    setError(null);
    try {
      const { keywords } = await suggestPackageKeywords({
        name: form.name,
        occasions: form.occasions,
        itemNames: chosen.map((c) => c.item.name),
        description: form.description || undefined,
      });
      const have = new Set(form.keywords.map((k) => k.toLowerCase()));
      const fresh = keywords.filter((k) => !have.has(k.toLowerCase()));
      setForm((f) => ({ ...f, keywords: [...f.keywords, ...fresh] }));
      setSuggestNote(
        fresh.length === 0
          ? "Nothing new to add; every suggestion was already here."
          : `Added ${fresh.length} ${fresh.length === 1 ? "suggestion" : "suggestions"}. Remove any that don't fit, add your own, then save.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get suggestions");
    } finally {
      setSuggesting(false);
    }
  }

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set<K extends keyof PackageInput>(key: K, value: PackageInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const query = search.trim().toLowerCase();
  const chosenIds = new Set(chosen.map((c) => c.item.id));
  const results =
    query === ""
      ? []
      : catalog.filter((i) => !chosenIds.has(i.id) && i.name.toLowerCase().includes(query)).slice(0, 8);

  const { sum, unpriced } = itemsSum(chosen.map((c) => ({ quantity: c.quantity, item: { price: c.item.price } })));
  const bundle = Number(form.price);
  const bundleValid = form.price.trim() !== "" && Number.isFinite(bundle) && bundle >= 0;
  const diff = bundleValid ? sum - bundle : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const input: PackageInput = { ...form, items: chosen.map((c) => ({ itemId: c.item.id, quantity: c.quantity })) };
    try {
      onSaved(pkg ? await updatePackage(pkg.id, input) : await createPackage(input));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!pkg) return;
    setSaving(true);
    setError(null);
    try {
      await deletePackage(pkg.id);
      onDeleted(pkg.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete");
      setSaving(false);
    }
  }

  const uploaded = isUploadedPhoto(form.photoUrl || null);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={pkg ? `Edit ${pkg.name}` : "New package"} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{pkg ? "Edit package" : "New package"}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          <div className="modal-grid">
            <label>
              Name*
              <input value={form.name} onChange={(e) => set("name", e.target.value)} required autoFocus />
            </label>
            <label>
              Bundle price*
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.price}
                onChange={(e) => set("price", e.target.value)}
                placeholder="e.g. 1899"
                required
              />
            </label>
            <label className="modal-span">
              Description
              <textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
            </label>
          </div>

          <div className="detail-field">
            <span className="detail-field-label">Occasions</span>
            <span className="muted field-help">
              Every occasion this package is offered under on the storefront. Publishing needs at least one.
              {form.occasions.length > 0 && ` Chosen: ${form.occasions.join(", ")}.`}
            </span>
            <div className="occasion-groups" role="group" aria-label="Occasions">
              {OCCASION_GROUPS.map((group) => (
                <div key={group.label} className="occasion-group">
                  <span className="occasion-group-label">{group.label}</span>
                  {group.occasions.map((occ) => (
                    <label key={`${group.label}:${occ}`} className="checkbox-label">
                      <input type="checkbox" checked={form.occasions.includes(occ)} onChange={(e) => toggleOccasion(occ, e.target.checked)} />
                      {occ}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="detail-field">
            <span className="detail-field-label">Search keywords</span>
            <span className="muted field-help">
              Short terms a customer might type to find this package ("dogs", "cartoon", "toddler", "outdoor"). Suggest
              keywords asks Claude for 5 to 8 from the name, occasions and items; edit the list, then save.
            </span>
            {form.keywords.length > 0 ? (
              <div className="tag-list">
                {form.keywords.map((kw) => (
                  <span key={kw} className="tag-chip">
                    {kw}
                    <button
                      type="button"
                      className="tag-chip-remove"
                      aria-label={`Remove keyword ${kw}`}
                      onClick={() => set("keywords", form.keywords.filter((k) => k !== kw))}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">No keywords yet.</p>
            )}
            <div className="keyword-editor">
              <input
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
                placeholder="Add a keyword"
                aria-label="New keyword"
                maxLength={40}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addKeyword(keywordDraft);
                  }
                }}
              />
              <button type="button" className="btn-secondary" onClick={() => addKeyword(keywordDraft)} disabled={keywordDraft.trim() === ""}>
                Add
              </button>
              <button type="button" className="btn-secondary btn-suggest" onClick={handleSuggest} disabled={suggesting || form.name.trim() === ""}>
                <Sparkles size={13} />
                {suggesting ? "Asking…" : "Suggest keywords"}
              </button>
            </div>
            {suggestNote && <span className="muted field-help">{suggestNote}</span>}
          </div>

          <div className="detail-field">
            <span className="detail-field-label">Photo</span>
            <PhotoDropZone
              value={form.photoUrl || null}
              alt="Package photo"
              onPhoto={(photoUrl) => set("photoUrl", photoUrl)}
              disabled={saving}
              compact
            />
            <div className="photo-actions">
              {uploaded ? (
                <>
                  <span className="muted">Photo attached. It saves with the package.</span>
                  <button type="button" className="btn-secondary" onClick={() => set("photoUrl", "")} disabled={saving}>
                    Remove photo
                  </button>
                </>
              ) : (
                <input
                  value={form.photoUrl}
                  onChange={(e) => set("photoUrl", e.target.value)}
                  placeholder="Or paste a photo URL, https://..."
                  aria-label="Photo URL"
                />
              )}
            </div>
          </div>

          <div className="detail-field">
            <span className="detail-field-label">Items in this package</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the catalog to add an item"
              aria-label="Search catalog items"
            />
            {results.length > 0 && (
              <ul className="picker-results">
                {results.map((item) => (
                  <li key={item.id} className="picker-row">
                    <span>
                      {item.name}
                      <span className="muted"> · {item.category}</span>
                    </span>
                    <span className="picker-row-side">
                      <span className="muted">{item.price === null ? "TBD" : usd(Number(item.price))}</span>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setChosen((prev) => [...prev, { item, quantity: 1 }]);
                          setSearch("");
                        }}
                      >
                        Add
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {query !== "" && results.length === 0 && <p className="muted">No catalog items match.</p>}

            {chosen.length === 0 ? (
              <p className="muted">No items yet. Search above to add some.</p>
            ) : (
              <ul className="chosen-list">
                {chosen.map(({ item, quantity }) => (
                  <li key={item.id} className="picker-row">
                    <span>
                      {item.name}
                      <span className="muted"> · {item.price === null ? "TBD" : usd(Number(item.price))}</span>
                    </span>
                    <span className="picker-row-side">
                      <label className="qty-field">
                        Qty
                        <input
                          type="number"
                          min={1}
                          max={99}
                          value={quantity}
                          aria-label={`Quantity of ${item.name}`}
                          onChange={(e) => {
                            const q = Math.max(1, Math.min(99, Number(e.target.value) || 1));
                            setChosen((prev) => prev.map((c) => (c.item.id === item.id ? { ...c, quantity: q } : c)));
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => setChosen((prev) => prev.filter((c) => c.item.id !== item.id))}
                      >
                        <X size={14} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="price-compare">
              <span>
                Items add up to <strong>{usd(sum)}</strong>
                {unpriced > 0 && <span className="muted"> plus {unpriced} with no price</span>}
              </span>
              <span>
                Bundle price <strong>{bundleValid ? usd(bundle) : "—"}</strong>
              </span>
              {diff !== null && (
                <span className={diff > 0 ? "price-diff price-diff-below" : diff < 0 ? "price-diff price-diff-above" : "price-diff"}>
                  {diff > 0 ? `${usd(diff)} below the items` : diff < 0 ? `${usd(-diff)} above the items` : "Same as the items"}
                </span>
              )}
            </div>
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="modal-foot">
            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? "Saving…" : pkg ? "Save changes" : "Save as draft"}
              </button>
              <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
                Cancel
              </button>
            </div>
            {pkg &&
              (confirmingDelete ? (
                <div className="form-actions">
                  <span className="muted">Delete this package for good?</span>
                  <button type="button" className="btn-secondary btn-danger" onClick={handleDelete} disabled={saving}>
                    Yes, delete
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setConfirmingDelete(false)} disabled={saving}>
                    Keep it
                  </button>
                </div>
              ) : (
                <button type="button" className="btn-secondary btn-danger" onClick={() => setConfirmingDelete(true)} disabled={saving}>
                  Delete package
                </button>
              ))}
          </div>
        </form>
      </div>
    </div>
  );
}
