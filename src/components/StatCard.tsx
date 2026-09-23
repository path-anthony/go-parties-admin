import type { ReactNode } from "react";

// The one metric card used everywhere a number needs a label: Overview's
// leads and crew, Inventory's catalog strip. A card with onClick is a
// button that opens the filtered view behind the number; a placeholder
// says what it is waiting on instead of showing a number.
export function StatCard({
  label,
  value,
  note,
  onClick,
  placeholder = false,
  wide = false,
  children,
}: {
  label: string;
  value?: ReactNode;
  note?: ReactNode;
  onClick?: () => void;
  placeholder?: boolean;
  wide?: boolean;
  children?: ReactNode;
}) {
  const className = ["kpi-card", placeholder ? "kpi-card-placeholder" : "", wide ? "kpi-card-wide" : "", onClick ? "kpi-card-click" : ""]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      <span className="kpi-label">{label}</span>
      {value !== undefined && <span className="kpi-value">{value}</span>}
      {note && <span className="kpi-note muted">{note}</span>}
      {children}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

export function StatGrid({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`kpi-grid ${className}`.trim()}>{children}</div>;
}
