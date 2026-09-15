import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { getLeadStatuses, getLeads, reorderLeads, updateLead } from "../../lib/api";
import type { Lead, LeadStatus } from "../../lib/types";
import { AddLeadForm } from "../AddLeadForm";
import { LeadCard } from "../LeadCard";
import { LeadDetailPanel } from "../LeadDetailPanel";

// Column top-bar colors cycle by position, since column names are whatever
// Settings says they are.
const ACCENT_COUNT = 5;

function columnIds(leads: Lead[], status: LeadStatus): string[] {
  return leads.filter((lead) => lead.status === status).map((lead) => lead.id);
}

function SortableLeadCard({
  lead,
  statuses,
  onOpen,
  onStatusChange,
}: {
  lead: Lead;
  statuses: LeadStatus[];
  onOpen: () => void;
  onStatusChange: (id: string, status: LeadStatus) => Promise<void>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: lead.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? "lead-sortable lead-sortable-dragging" : "lead-sortable"}
      {...attributes}
      {...listeners}
      // Declared after the spread so it wins, so it has to hand every other
      // key back to dnd-kit's own handler or keyboard dragging stops working.
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
          return;
        }
        (listeners?.onKeyDown as ((event: KeyboardEvent) => void) | undefined)?.(e);
      }}
    >
      <LeadCard lead={lead} statuses={statuses} onOpen={onOpen} onStatusChange={onStatusChange} />
    </div>
  );
}

function PipelineColumn({
  status,
  accent,
  statuses,
  leads,
  onOpen,
  onStatusChange,
}: {
  status: LeadStatus;
  accent: number;
  statuses: LeadStatus[];
  leads: Lead[];
  onOpen: (id: string) => void;
  onStatusChange: (id: string, status: LeadStatus) => Promise<void>;
}) {
  // The column itself is a drop target so a card can be dropped into an
  // empty column, or below the last card, not only onto another card.
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const className = `pipeline-col pipeline-col-accent-${accent}${isOver ? " pipeline-col-over" : ""}`;
  return (
    <section ref={setNodeRef} className={className}>
      <header className="pipeline-col-head">
        <span className="pipeline-col-title">{status}</span>
        <span className="pipeline-col-count">{leads.length}</span>
      </header>
      <SortableContext items={leads.map((lead) => lead.id)} strategy={verticalListSortingStrategy}>
        <div className="pipeline-col-body">
          {leads.length === 0 ? (
            <p className="muted pipeline-empty">Nothing here yet.</p>
          ) : (
            leads.map((lead) => (
              <SortableLeadCard
                key={lead.id}
                lead={lead}
                statuses={statuses}
                onOpen={() => onOpen(lead.id)}
                onStatusChange={onStatusChange}
              />
            ))
          )}
        </div>
      </SortableContext>
    </section>
  );
}

export function LeadsScreen() {
  const [statuses, setStatuses] = useState<LeadStatus[] | null>(null);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Board state as it was when the drag started, to snap back to if the
  // drop is cancelled or the save fails.
  const dragSnapshot = useRef<Lead[] | null>(null);
  // The click that ends a drag would otherwise open the detail panel.
  const justDragged = useRef(false);

  const sensors = useSensors(
    // A plain click must open the panel, so a drag only starts after the
    // pointer has actually moved.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  useEffect(() => {
    Promise.all([getLeadStatuses(), getLeads()])
      .then(([rows, list]) => {
        setStatuses(rows.map((row) => row.name));
        setLeads(list);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load leads"));
  }, []);

  function isStatus(id: string): boolean {
    return statuses?.includes(id) ?? false;
  }

  function columnOf(id: string): LeadStatus | undefined {
    if (isStatus(id)) return id;
    return leads?.find((lead) => lead.id === id)?.status;
  }

  function replaceLead(updated: Lead, movedColumns: boolean) {
    setLeads((prev) => {
      const rest = (prev ?? []).filter((lead) => lead.id !== updated.id);
      if (movedColumns) return [updated, ...rest];
      return (prev ?? []).map((lead) => (lead.id === updated.id ? updated : lead));
    });
  }

  // Optimistic: the card jumps columns immediately, then settles on the
  // server's copy, or jumps back if the save fails (the card shows the error).
  async function handleStatusChange(id: string, status: LeadStatus) {
    const previous = leads?.find((lead) => lead.id === id)?.status;
    setLeads((prev) => (prev ?? []).map((lead) => (lead.id === id ? { ...lead, status } : lead)));
    try {
      const updated = await updateLead(id, { status });
      replaceLead(updated, previous !== updated.status);
    } catch (err) {
      if (previous) {
        setLeads((prev) => (prev ?? []).map((lead) => (lead.id === id ? { ...lead, status: previous } : lead)));
      }
      throw err;
    }
  }

  function handleOpen(id: string) {
    if (justDragged.current) return;
    setSelectedId(id);
  }

  function handleDragStart(e: DragStartEvent) {
    dragSnapshot.current = leads;
    justDragged.current = true;
    setActiveId(String(e.active.id));
  }

  // Moving between columns happens live while hovering, so the card visibly
  // joins the new column's list before it's dropped. Within-column order is
  // handled by the sortable strategy until the drop.
  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || !leads) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    const from = columnOf(activeKey);
    const to = columnOf(overKey);
    if (!from || !to || from === to) return;

    setLeads((prev) => {
      const list = prev ?? [];
      const moving = list.find((lead) => lead.id === activeKey);
      if (!moving) return prev;
      const without = list.filter((lead) => lead.id !== activeKey);
      const moved = { ...moving, status: to };
      if (overKey === to) {
        const lastInTarget = without.map((lead) => lead.status).lastIndexOf(to);
        const insertAt = lastInTarget === -1 ? without.length : lastInTarget + 1;
        return [...without.slice(0, insertAt), moved, ...without.slice(insertAt)];
      }
      const overIndex = without.findIndex((lead) => lead.id === overKey);
      return [...without.slice(0, overIndex), moved, ...without.slice(overIndex)];
    });
  }

  function finishDrag() {
    setActiveId(null);
    // Let the click that follows pointerup pass before re-enabling opens.
    setTimeout(() => {
      justDragged.current = false;
    }, 50);
  }

  function revertDrag() {
    if (dragSnapshot.current) setLeads(dragSnapshot.current);
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || !leads) {
      revertDrag();
      finishDrag();
      return;
    }
    const activeKey = String(active.id);
    const overKey = String(over.id);
    const column = columnOf(activeKey);
    if (!column) {
      finishDrag();
      return;
    }

    let next = leads;
    if (overKey !== activeKey && !isStatus(overKey) && columnOf(overKey) === column) {
      const ids = columnIds(leads, column);
      const reordered = arrayMove(ids, ids.indexOf(activeKey), ids.indexOf(overKey));
      const byId = new Map(leads.map((lead) => [lead.id, lead]));
      let k = 0;
      next = leads.map((lead) => (lead.status === column ? (byId.get(reordered[k++]) as Lead) : lead));
      setLeads(next);
    }

    const before = dragSnapshot.current;
    const ids = columnIds(next, column);
    const changed =
      !before ||
      before.find((lead) => lead.id === activeKey)?.status !== column ||
      columnIds(before, column).join() !== ids.join();

    if (changed) {
      setError(null);
      reorderLeads(column, ids)
        .then((rows) => {
          const byId = new Map(rows.map((row) => [row.id, row]));
          setLeads((prev) => (prev ?? []).map((lead) => byId.get(lead.id) ?? lead));
        })
        .catch((err) => {
          revertDrag();
          setError(err instanceof Error ? err.message : "Couldn't save the new order");
        });
    }
    finishDrag();
  }

  const activeLead = activeId ? leads?.find((lead) => lead.id === activeId) ?? null : null;
  const selected = selectedId ? leads?.find((lead) => lead.id === selectedId) ?? null : null;
  const ready = statuses !== null && leads !== null;

  return (
    <div className="screen screen-wide">
      <div className="screen-head screen-head-row">
        <div>
          <h2>Leads</h2>
          <p className="muted">Every lead, grouped by stage. Drag to reorder or move between stages, click to open.</p>
        </div>
        {!adding && ready && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            Add lead
          </button>
        )}
      </div>

      {adding && statuses && (
        <section className="panel">
          <h2>New lead</h2>
          <AddLeadForm
            statuses={statuses}
            onAdded={(lead) => {
              setLeads((prev) => [lead, ...(prev ?? [])]);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </section>
      )}

      {error && <p className="form-error">{error}</p>}
      {!ready && !error && <p className="muted">Loading…</p>}

      {ready && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            revertDrag();
            finishDrag();
          }}
        >
          <div className="pipeline" style={{ gridTemplateColumns: `repeat(${statuses.length}, minmax(230px, 1fr))` }}>
            {statuses.map((status, index) => (
              <PipelineColumn
                key={status}
                status={status}
                accent={index % ACCENT_COUNT}
                statuses={statuses}
                leads={leads.filter((lead) => lead.status === status)}
                onOpen={handleOpen}
                onStatusChange={handleStatusChange}
              />
            ))}
          </div>
          <DragOverlay>
            {activeLead && (
              <div className="lead-sortable lead-sortable-overlay">
                <LeadCard lead={activeLead} statuses={statuses} onOpen={() => {}} onStatusChange={async () => {}} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      <LeadDetailPanel
        lead={selected}
        statuses={statuses ?? []}
        onClose={() => setSelectedId(null)}
        onUpdated={(updated, movedColumns) => replaceLead(updated, movedColumns)}
      />
    </div>
  );
}
