export function EmptyScreen({ title }: { title: string }) {
  return (
    <div className="screen">
      <div className="screen-head">
        <h2>{title}</h2>
      </div>
      <p className="muted">Nothing here yet.</p>
    </div>
  );
}
