// "Nov 10, 3:04 PM ET", for a notification row.
const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
export const notificationWhen = (iso: string) => `${fmt.format(new Date(iso))} ET`;
