export function ComingSoonScreen({
  headline,
  description,
}: {
  headline: string;
  description: string[];
}) {
  return (
    <div className="screen">
      <div className="coming-soon">
        <span className="coming-soon-tag">Coming soon</span>
        <h2>{headline}</h2>
        {description.map((paragraph) => (
          <p key={paragraph} className="muted">
            {paragraph}
          </p>
        ))}
      </div>
    </div>
  );
}
