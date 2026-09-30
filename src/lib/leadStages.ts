// Which Leads-board columns end the automated follow-up journey. Columns are
// named by the admin (Settings > Lead pipeline), so the scheduler finds
// them by name, ignoring case. A lead in the won column, or in the lost
// column, gets no more follow-ups.
export const WON_STAGE = "Booked";
export const LOST_STAGE = "Lost";

export const isWonStage = (name: string) => name.trim().toLowerCase() === WON_STAGE.toLowerCase();
export const isLostStage = (name: string) => name.trim().toLowerCase() === LOST_STAGE.toLowerCase();

// Warnings for the pipeline settings page, given the current column names.
export function stageWarnings(columns: string[]): string[] {
  const out: string[] = [];
  if (!columns.some(isWonStage)) {
    out.push(`There is no column named "${WON_STAGE}". Follow-ups only stop for a won lead once it has a booking. Rename a column back to "${WON_STAGE}" (or add one) so moving a lead there stops them.`);
  }
  if (!columns.some(isLostStage)) {
    out.push(`There is no column named "${LOST_STAGE}". Leads you give up on will keep getting follow-ups. Rename a column back to "${LOST_STAGE}" (or add one) so moving a lead there stops them.`);
  }
  return out;
}
