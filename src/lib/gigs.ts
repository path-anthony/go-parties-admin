export function formatEventDay(eventDate: string): string {
  return new Date(eventDate).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function gigPillClass(status: string): string {
  if (status === "Filled") return "status-pill status-pill-live";
  if (status === "Needs Crew") return "status-pill status-pill-needs";
  return "status-pill";
}
